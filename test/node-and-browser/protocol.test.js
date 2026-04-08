// polyfill window.process for "assert" package
try {
  if (!window.process?.env) {
    window.process = {env: {}}
  }
} catch (e) {}

// log full objects in node
try {
  ;(await import('util')).inspect.defaultOptions.depth = null
} catch (e) {}

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {assertTestServerDidntCrash} from '../test-server/monitor-test-server.js'

import PKC from '@pkc/pkc-js'
import * as cborg from 'cborg'
import {create as CreateKuboRpcClient} from 'kubo-rpc-client'
import {encryptEd25519AesGcm, decryptEd25519AesGcm} from '../utils/encryption.js'
import {fromString as uint8ArrayFromString} from 'uint8arrays/from-string'
import {toString as uint8ArrayToString} from 'uint8arrays/to-string'
import {signBufferEd25519, verifyBufferEd25519} from '../utils/signature.js'
import {getChallengeRequestIdFromPublicKey, generateSigner} from '../utils/crypto.js'
import {offlineIpfs, pubsubIpfs} from '../test-server/ipfs-config.js'
const pkcOptions = {
  kuboRpcClientsOptions: [`http://127.0.0.1:${offlineIpfs.apiPort}/api/v0`],
  pubsubKuboRpcClientsOptions: [`http://127.0.0.1:${pubsubIpfs.apiPort}/api/v0`],
  httpRoutersOptions: [],
}
const ipfsGatewayUrl = `http://127.0.0.1:${offlineIpfs.gatewayPort}`
console.log({pkcOptions, ipfsGatewayUrl})
const pubsubIpfsClient = CreateKuboRpcClient({
  url: pkcOptions.pubsubKuboRpcClientsOptions[0],
})
const ipfsClient = CreateKuboRpcClient({
  url: pkcOptions.kuboRpcClientsOptions[0],
})
import signers from '../fixtures/signers.js'
import {isCI} from '../utils/test-utils.js'
let pkc
let publishedCommentCid

// uncomment to test flakiness
// let i = 100; while (--i)
describe('protocol (node and browser)', () => {
  // retry because sometimes CI is flaky
  // if (isCI()) {
  //   this.retries(3)
  // }

  beforeAll(async () => {
    pkc = await PKC(pkcOptions)
    pkc.on('error', console.error)
  })
  afterAll(async () => {
    await pkc.destroy()
  })

  beforeEach(async () => {
    await assertTestServerDidntCrash()
  })
  afterEach(async () => {
    await assertTestServerDidntCrash()
  })

  // publishedCommentCid is defined in this test, add .only if needed
  it('create comment and publish over pubsub', async () => {
    const communitySigner = signers[0]
    const authorSigner = signers[1]
    const pubsubMessageSigner = await generateSigner()

    // create comment
    const comment = {
      communityPublicKey: communitySigner.address,
      timestamp: Math.round(Date.now() / 1000),
      protocolVersion: '1.0.0',
      content: 'content',
      title: 'title',
    }

    // create comment signature
    // signed prop names can be in any order
    const commentSignedPropertyNames = shuffleArray(Object.keys(comment))
    const commentSignature = await sign({
      objectToSign: comment,
      signedPropertyNames: commentSignedPropertyNames,
      privateKey: authorSigner.privateKey,
    })
    comment.signature = {
      signature: commentSignature,
      publicKey: authorSigner.publicKey,
      type: 'ed25519',
      signedPropertyNames: commentSignedPropertyNames,
    }
    console.log({comment})

    // encrypt publication
    const encrypted = await encryptEd25519AesGcm(JSON.stringify({comment}), pubsubMessageSigner.privateKey, communitySigner.publicKey)

    // create pubsub challenge request message
    const challengeRequestPubsubMessage = {
      type: 'CHALLENGEREQUEST',
      timestamp: Math.round(Date.now() / 1000),
      challengeRequestId: await getChallengeRequestIdFromPublicKey(pubsubMessageSigner.publicKey),
      acceptedChallengeTypes: ['image/png'],
      encrypted,
      protocolVersion: '1.0.0',
      userAgent: `/protocol-test:1.0.0/`,
    }

    // create pubsub challenge request message signature
    const challengeRequestPubsubMessageSignedPropertyNames = shuffleArray(Object.keys(challengeRequestPubsubMessage))
    const challengeRequestPubsubMessageSignature = await sign({
      objectToSign: challengeRequestPubsubMessage,
      signedPropertyNames: challengeRequestPubsubMessageSignedPropertyNames,
      privateKey: pubsubMessageSigner.privateKey,
    })
    challengeRequestPubsubMessage.signature = {
      signature: uint8ArrayFromString(challengeRequestPubsubMessageSignature, 'base64'),
      publicKey: uint8ArrayFromString(pubsubMessageSigner.publicKey, 'base64'),
      type: 'ed25519',
      signedPropertyNames: challengeRequestPubsubMessageSignedPropertyNames,
    }
    console.log({challengeRequestPubsubMessage})

    // publish pubsub challenge request message
    const challengePubsubMessage = await publishPubsubMessage(communitySigner.address, challengeRequestPubsubMessage)
    console.log({challengePubsubMessage})

    // decrypt challenges
    const challenges = JSON.parse(await decryptEd25519AesGcm(challengePubsubMessage.encrypted, pubsubMessageSigner.privateKey, communitySigner.publicKey)).challenges
    console.log({challenges})

    // validate challenge pubsub message
    expect(challenges[0].challenge).to.equal('1+1=?')
    expect(challenges[0].type).to.equal('text/plain')
    expect(challengePubsubMessage.type).to.equal('CHALLENGE')
    expect(challengePubsubMessage.encrypted.type).to.equal('ed25519-aes-gcm')
    expect(challengePubsubMessage.challengeRequestId.toString()).to.equal(challengeRequestPubsubMessage.challengeRequestId.toString())

    // validate challenge pubsub message community owner signature
    expect(challengePubsubMessage.signature.type).to.equal('ed25519')
    expect(uint8ArrayToString(challengePubsubMessage.signature.publicKey, 'base64')).to.equal(communitySigner.publicKey)
    expect(challengePubsubMessage.signature.signedPropertyNames).to.include.members(['type', 'timestamp', 'challengeRequestId', 'encrypted'])
    expect(
      await verify({
        objectToSign: challengePubsubMessage,
        signedPropertyNames: challengePubsubMessage.signature.signedPropertyNames,
        signature: uint8ArrayToString(challengePubsubMessage.signature.signature, 'base64'),
        publicKey: communitySigner.publicKey,
      }),
    ).to.equal(true)

    // create pubsub challenge answer message
    const challengeAnswers = ['2']
    const encryptedChallengeAnswers = await encryptEd25519AesGcm(JSON.stringify({challengeAnswers}), pubsubMessageSigner.privateKey, communitySigner.publicKey)
    const challengeAnswerPubsubMessage = {
      type: 'CHALLENGEANSWER',
      timestamp: Math.round(Date.now() / 1000),
      challengeRequestId: challengeRequestPubsubMessage.challengeRequestId,
      encrypted: encryptedChallengeAnswers,
      protocolVersion: '1.0.0',
      userAgent: `/protocol-test:1.0.0/`,
    }

    // create pubsub challenge answer message signature
    const challengeAnswerPubsubMessageSignedPropertyNames = shuffleArray(Object.keys(challengeAnswerPubsubMessage))
    const challengeAnswerPubsubMessageSignature = await sign({
      objectToSign: challengeAnswerPubsubMessage,
      signedPropertyNames: challengeAnswerPubsubMessageSignedPropertyNames,
      privateKey: pubsubMessageSigner.privateKey,
    })
    challengeAnswerPubsubMessage.signature = {
      signature: uint8ArrayFromString(challengeAnswerPubsubMessageSignature, 'base64'),
      publicKey: uint8ArrayFromString(pubsubMessageSigner.publicKey, 'base64'),
      type: 'ed25519',
      signedPropertyNames: challengeAnswerPubsubMessageSignedPropertyNames,
    }
    console.log({challengeAnswerPubsubMessage})

    // publish pubsub challenge answer message
    const challengeVerificationPubsubMessage = await publishPubsubMessage(communitySigner.address, challengeAnswerPubsubMessage)
    console.log({challengeVerificationPubsubMessage})

    // decrypt challenge verification publication
    const publishedPublication = JSON.parse(
      await decryptEd25519AesGcm(challengeVerificationPubsubMessage.encrypted, pubsubMessageSigner.privateKey, communitySigner.publicKey),
    )
    console.log({publishedPublication})
    publishedCommentCid = publishedPublication.commentUpdate.cid
    expect(publishedCommentCid).to.be.a('string')

    // validate challenge verification pubsub message
    expect(publishedPublication.comment.content).to.equal(comment.content)
    expect(publishedPublication.comment.title).to.equal(comment.title)
    expect(publishedPublication.comment.timestamp).to.equal(comment.timestamp)
    expect(publishedPublication.comment.depth).to.equal(0)
    expect(publishedPublication.comment.communityPublicKey).to.equal(comment.communityPublicKey)
    expect(publishedPublication.comment.signature).to.deep.equal(comment.signature)
    expect(publishedPublication.commentUpdate.cid.startsWith('Qm')).toBe(true)
    expect(challengeVerificationPubsubMessage.type).to.equal('CHALLENGEVERIFICATION')
    expect(challengeVerificationPubsubMessage.encrypted.type).to.equal('ed25519-aes-gcm')
    expect(challengeVerificationPubsubMessage.challengeSuccess).to.equal(true)
    expect(challengeVerificationPubsubMessage.reason).to.be.undefined
    expect(challengeVerificationPubsubMessage.challengeErrors).to.be.undefined
    expect(challengeVerificationPubsubMessage.challengeRequestId.toString()).to.equal(challengeAnswerPubsubMessage.challengeRequestId.toString())
    expect(challengeVerificationPubsubMessage.challengeAnswerId).to.equal(undefined)

    // validate challenge verification pubsub message community owner signature
    expect(challengeVerificationPubsubMessage.signature.type).to.equal('ed25519')
    expect(uint8ArrayToString(challengeVerificationPubsubMessage.signature.publicKey, 'base64')).to.equal(communitySigner.publicKey)
    expect(challengeVerificationPubsubMessage.signature.signedPropertyNames).to.include.members(['type', 'challengeRequestId', 'challengeSuccess', 'encrypted'])
    expect(
      await verify({
        objectToSign: challengeVerificationPubsubMessage,
        signedPropertyNames: challengeVerificationPubsubMessage.signature.signedPropertyNames,
        signature: uint8ArrayToString(challengeVerificationPubsubMessage.signature.signature, 'base64'),
        publicKey: communitySigner.publicKey,
      }),
    ).to.equal(true)

    // fetch published comment with ipfs
    const commentIpfs = await fetchJson(`${ipfsGatewayUrl}/ipfs/${publishedPublication.commentUpdate.cid}`)
    console.log({commentIpfs})

    // validate comment ipfs
    expect(commentIpfs.content).to.equal(publishedPublication.comment.content)
    expect(commentIpfs.title).to.equal(publishedPublication.comment.title)
    expect(commentIpfs.timestamp).to.equal(publishedPublication.comment.timestamp)
    expect(commentIpfs.depth).to.equal(publishedPublication.comment.depth)
    expect(commentIpfs.communityPublicKey).to.equal(publishedPublication.comment.communityPublicKey)
    expect(commentIpfs.signature).to.deep.equal(publishedPublication.comment.signature)
    expect(commentIpfs.cid).to.equal(undefined)

    // fetch commentUpdate - retry the whole IPNS+postUpdates chain since IPNS might be stale
    await sleep(3000)
    let commentUpdate
    let fetchAttempts = 40
    while (fetchAttempts--) {
      try {
        const communityRecord = await fetchJson(`${ipfsGatewayUrl}/ipns/${commentIpfs.communityPublicKey}`)
        commentUpdate = await fetchJson(`${ipfsGatewayUrl}/ipfs/${communityRecord.postUpdates['86400']}/${publishedCommentCid}/update`)
        break
      } catch (e) {
        if (fetchAttempts === 0) throw e
        console.log(`commentUpdate not ready yet, retrying...`)
        await sleep(1000)
      }
    }
    console.log({commentUpdate})

    // validate comment ipns
    expect(commentUpdate.upvoteCount).to.equal(0)
    expect(commentUpdate.downvoteCount).to.equal(0)
    expect(commentUpdate.replyCount).to.equal(0)
    expect(typeof commentUpdate.updatedAt).to.equal('number')
    expect(typeof commentUpdate.author?.community?.firstCommentTimestamp).to.equal('number')
    expect(typeof commentUpdate.author?.community?.lastCommentCid).to.equal('string')
    expect(typeof commentUpdate.author?.community?.postScore).to.equal('number')
    expect(typeof commentUpdate.author?.community?.replyScore).to.equal('number')

    // validate comment ipns signature
    expect(commentUpdate.signature.type).to.equal('ed25519')
    expect(commentUpdate.signature.publicKey).to.equal(communitySigner.publicKey)
    expect(commentUpdate.signature.signedPropertyNames.sort()).to.deep.equal(
      Object.keys(commentUpdate)
        .filter((key) => key !== 'signature')
        .sort(),
    )
    expect(
      await verify({
        objectToSign: commentUpdate,
        signedPropertyNames: commentUpdate.signature.signedPropertyNames,
        signature: commentUpdate.signature.signature,
        publicKey: communitySigner.publicKey,
      }),
    ).to.equal(true)

    // fetch community ipns until community.posts.pages.new have at least 1 comment
    let communityIpns
    let maxAttempts = 200
    while (maxAttempts--) {
      communityIpns = await fetchJson(`${ipfsGatewayUrl}/ipns/${communitySigner.address}`)
      if (communityIpns.posts?.pages?.hot?.comments?.length > 0) {
        break
      }
      console.log(`community.posts.pages.new doesn't have at least 1 comment, retry fetching community...`)
      await new Promise((r) => setTimeout(r, 100)) // sleep
    }
    console.log({communityIpns})

    // validate community ipns
    expect(typeof communityIpns.updatedAt).to.equal('number')

    // validate community ipns signature
    expect(communityIpns.signature.type).to.equal('ed25519')
    expect(communityIpns.signature.publicKey).to.equal(communitySigner.publicKey)
    expect(communityIpns.signature.signedPropertyNames).to.include.members(Object.keys(communityIpns).filter((key) => key !== 'signature'))
    expect(
      await verify({
        objectToSign: communityIpns,
        signedPropertyNames: communityIpns.signature.signedPropertyNames,
        signature: communityIpns.signature.signature,
        publicKey: communitySigner.publicKey,
      }),
    ).to.equal(true)

    // validate included posts
    expect(communityIpns.posts.pages.hot.comments.length).to.be.greaterThan(0)
    const pageComment = communityIpns.posts.pages.hot.comments.filter((pageComment) => pageComment.commentUpdate.cid === publishedCommentCid)[0]
    if (pageComment) {
      expect(pageComment.commentUpdate.cid).to.equal(publishedCommentCid)
      for (const propertyName in comment) {
        expect(pageComment.comment[propertyName]).to.deep.equal(comment[propertyName])
      }
      expect(pageComment.commentUpdate.cid).to.equal(publishedCommentCid)
      expect(typeof pageComment.commentUpdate.updatedAt).to.equal('number')
      expect(pageComment.commentUpdate.signature.publicKey).to.equal(communitySigner.publicKey)
    } else {
      // only throw in CI because in dev we need to retry a lot and pageComment won't be in first page
      if (isCI()) {
        throw Error('published comment is not in community.posts.pages.hot, maybe too many test comments were published and test server must be restarted')
      }
    }

    // all comments in preloaded, no pageCids
    expect(communityIpns.posts?.pageCids?.new).to.be.undefined
  })

  it('create reply and publish over pubsub', async () => {
    const communitySigner = signers[0]
    const authorSigner = signers[5]
    const pubsubMessageSigner = await generateSigner()

    // create reply
    const reply = {
      parentCid: publishedCommentCid,
      communityPublicKey: communitySigner.address,
      timestamp: Math.round(Date.now() / 1000),
      protocolVersion: '1.0.0',
      content: 'reply content',
      postCid: publishedCommentCid,
    }

    // create reply signature
    // signed prop names can be in any order
    const replySignedPropertyNames = shuffleArray(Object.keys(reply))
    const replySignature = await sign({
      objectToSign: reply,
      signedPropertyNames: replySignedPropertyNames,
      privateKey: authorSigner.privateKey,
    })
    reply.signature = {
      signature: replySignature,
      publicKey: authorSigner.publicKey,
      type: 'ed25519',
      signedPropertyNames: replySignedPropertyNames,
    }
    console.log({reply})

    // encrypt publication
    const encryptedPublication = await encryptEd25519AesGcm(JSON.stringify({comment: reply}), pubsubMessageSigner.privateKey, communitySigner.publicKey)

    // create pubsub challenge request message
    const challengeRequestPubsubMessage = {
      type: 'CHALLENGEREQUEST',
      timestamp: Math.round(Date.now() / 1000),
      challengeRequestId: await getChallengeRequestIdFromPublicKey(pubsubMessageSigner.publicKey),
      acceptedChallengeTypes: ['image/png'],
      encrypted: encryptedPublication,
      protocolVersion: '1.0.0',
      userAgent: `/protocol-test:1.0.0/`,
    }

    // create pubsub challenge request message signature
    const challengeRequestPubsubMessageSignedPropertyNames = shuffleArray(Object.keys(challengeRequestPubsubMessage))
    const challengeRequestPubsubMessageSignature = await sign({
      objectToSign: challengeRequestPubsubMessage,
      signedPropertyNames: challengeRequestPubsubMessageSignedPropertyNames,
      privateKey: pubsubMessageSigner.privateKey,
    })
    challengeRequestPubsubMessage.signature = {
      signature: uint8ArrayFromString(challengeRequestPubsubMessageSignature, 'base64'),
      publicKey: uint8ArrayFromString(pubsubMessageSigner.publicKey, 'base64'),
      type: 'ed25519',
      signedPropertyNames: challengeRequestPubsubMessageSignedPropertyNames,
    }
    console.log({challengeRequestPubsubMessage})

    // publish pubsub challenge request message
    const challengePubsubMessage = await publishPubsubMessage(communitySigner.address, challengeRequestPubsubMessage)
    console.log({challengePubsubMessage})
    expect(challengePubsubMessage.type).to.equal('CHALLENGE')

    // decrypt challenges
    const challenges = JSON.parse(await decryptEd25519AesGcm(challengePubsubMessage.encrypted, pubsubMessageSigner.privateKey, communitySigner.publicKey)).challenges
    console.log({challenges})

    // create pubsub challenge answer message
    const challengeAnswers = ['2']
    const encryptedChallengeAnswers = await encryptEd25519AesGcm(JSON.stringify({challengeAnswers}), pubsubMessageSigner.privateKey, communitySigner.publicKey)
    const challengeAnswerPubsubMessage = {
      type: 'CHALLENGEANSWER',
      timestamp: Math.round(Date.now() / 1000),
      challengeRequestId: challengeRequestPubsubMessage.challengeRequestId,
      encrypted: encryptedChallengeAnswers,
      protocolVersion: '1.0.0',
      userAgent: `/protocol-test:1.0.0/`,
    }

    // create pubsub challenge answer message signature
    const challengeAnswerPubsubMessageSignedPropertyNames = shuffleArray(Object.keys(challengeAnswerPubsubMessage))
    const challengeAnswerPubsubMessageSignature = await sign({
      objectToSign: challengeAnswerPubsubMessage,
      signedPropertyNames: challengeAnswerPubsubMessageSignedPropertyNames,
      privateKey: pubsubMessageSigner.privateKey,
    })
    challengeAnswerPubsubMessage.signature = {
      signature: uint8ArrayFromString(challengeAnswerPubsubMessageSignature, 'base64'),
      publicKey: uint8ArrayFromString(pubsubMessageSigner.publicKey, 'base64'),
      type: 'ed25519',
      signedPropertyNames: challengeAnswerPubsubMessageSignedPropertyNames,
    }
    console.log({challengeAnswerPubsubMessage})

    // publish pubsub challenge answer message
    const challengeVerificationPubsubMessage = await publishPubsubMessage(communitySigner.address, challengeAnswerPubsubMessage)
    console.log({challengeVerificationPubsubMessage})

    // decrypt challenge verification publication
    const publishedPublication = JSON.parse(
      await decryptEd25519AesGcm(challengeVerificationPubsubMessage.encrypted, pubsubMessageSigner.privateKey, communitySigner.publicKey),
    )
    console.log({publishedPublication})
    const replyCid = publishedPublication.commentUpdate.cid

    // fetch parent comment update until it has reply
    let parentCommentUpdate
    let maxAttempts = 200
    await sleep(3000)
    while (maxAttempts--) {
      const communityIpfs = await fetchJson(`${ipfsGatewayUrl}/ipns/${publishedPublication.comment.communityPublicKey}`)
      parentCommentUpdate = await fetchJson(`${ipfsGatewayUrl}/ipfs/${communityIpfs.postUpdates['86400']}/${publishedPublication.comment.parentCid}/update`)
      if (parentCommentUpdate?.replyCount > 0) {
        break
      }
      console.log(`parent commentUpdate.replyCount isn't at least 1, retry fetching CommentUpdate...`)
      await new Promise((r) => setTimeout(r, 100)) // sleep
    }
    console.log({parentCommentUpdate})

    // validate parent comment update
    expect(parentCommentUpdate).to.not.equal(undefined)
    expect(parentCommentUpdate.replyCount).to.equal(1)
    expect(typeof parentCommentUpdate.updatedAt).to.equal('number')

    // validate included replies
    expect(parentCommentUpdate.replies.pages.best.comments.length).to.equal(1)
    expect(parentCommentUpdate.replies.pages.best.comments[0].commentUpdate.cid).to.equal(replyCid)
    for (const propertyName in reply) {
      expect(parentCommentUpdate.replies.pages.best.comments[0].comment[propertyName]).to.deep.equal(reply[propertyName])
    }
    expect(parentCommentUpdate.replies.pages.best.comments[0].commentUpdate.cid).to.equal(replyCid)
    expect(typeof parentCommentUpdate.replies.pages.best.comments[0].commentUpdate.updatedAt).to.equal('number')
    expect(parentCommentUpdate.replies.pages.best.comments[0].commentUpdate.signature.publicKey).to.equal(communitySigner.publicKey)

    // fetch replies page ipfs
    expect(parentCommentUpdate.replies?.pageCids?.new).to.be.undefined
  })

  it('create community and listen over pubsub', async () => {
    // change the community signer to a community that isn't running in the test server
    const communitySigner = signers[1]
    const authorSigner = signers[0]

    // create community ipns object
    const communityIpns = {
      title: 'title',
      description: 'description',
      createdAt: Math.round(Date.now() / 1000),
      updatedAt: Math.round(Date.now() / 1000),
      statsCid: 'QmU1HXq547gXM5DpZMJubKFRKGET4MZUr5xmJj6ceASB1T',
      challenges: [],
      postUpdates: undefined,
      protocolVersion: '1.0.0',
      encryption: {
        type: 'ed25519-aes-gcm',
        publicKey: communitySigner.publicKey,
      },
      // TODO: remove pubsubTopic should be optional
      pubsubTopic: communitySigner.address,
    }

    // create community ipns signature
    const communityIpnsSignedPropertyNames = shuffleArray(Object.keys(communityIpns))
    const communityIpnsSignature = await sign({
      objectToSign: communityIpns,
      signedPropertyNames: communityIpnsSignedPropertyNames,
      privateKey: communitySigner.privateKey,
    })
    communityIpns.signature = {
      signature: communityIpnsSignature,
      publicKey: communitySigner.publicKey,
      type: 'ed25519',
      signedPropertyNames: communityIpnsSignedPropertyNames,
    }
    console.log({communityIpns})

    // publish ipns
    const communityIpnsFile = await ipfsClient.add(JSON.stringify(communityIpns))
    await ipfsClient.name.publish(communityIpnsFile.path, {
      lifetime: '72h',
      key: communitySigner.address, // ipfs key name imported in test server
      allowOffline: true,
    })

    // listen for comment over p2p
    const signer = await pkc.createSigner({
      privateKey: authorSigner.privateKey,
      type: 'ed25519',
    })
    const createCommentOptions = {
      communityAddress: communitySigner.address,
      signer,
      title: 'title',
      content: 'content',
    }
    const comment = await pkc.createComment({...createCommentOptions})
    comment.on('error', console.log)
    const pubsub = await pubsubSubscribe(communitySigner.address)
    comment.on('challenge', (challenge) => {
      console.log('challenge event')
      comment.publishChallengeAnswers(['2']).catch(console.error)
    })
    const challengeVerificationPromise = new Promise((resolve) => {
      comment.on('challengeverification', (challengeVerification) => {
        console.log('challengeverification event')
        resolve(challengeVerification)
      })
    })
    comment.publish().catch(console.error)
    const challengeRequestPubsubMessage = await pubsub.getMessage()

    // decrypt publication
    Object.assign(
      challengeRequestPubsubMessage,
      JSON.parse(
        await decryptEd25519AesGcm(
          challengeRequestPubsubMessage.encrypted,
          communitySigner.privateKey,
          uint8ArrayToString(challengeRequestPubsubMessage.signature.publicKey, 'base64'),
        ),
      ),
    )
    console.log({challengeRequestPubsubMessage})

    // validate challenge request pubsub message
    expect(challengeRequestPubsubMessage.type).to.equal('CHALLENGEREQUEST')
    expect(challengeRequestPubsubMessage.encrypted.type).to.equal('ed25519-aes-gcm')
    expect(typeof challengeRequestPubsubMessage.challengeRequestId).to.equal('object')

    // validate challenge request pubsub message signature
    expect(challengeRequestPubsubMessage.signature.type).to.equal('ed25519')
    expect(challengeRequestPubsubMessage.signature.publicKey).to.not.equal(authorSigner.publicKey)
    expect(challengeRequestPubsubMessage.signature.signedPropertyNames).to.include.members(['type', 'challengeRequestId', 'encrypted', 'acceptedChallengeTypes'])
    expect(
      await verify({
        objectToSign: challengeRequestPubsubMessage,
        signedPropertyNames: challengeRequestPubsubMessage.signature.signedPropertyNames,
        signature: uint8ArrayToString(challengeRequestPubsubMessage.signature.signature, 'base64'),
        // use a random new public key, which must be the same with all future same challengeRequestId
        publicKey: uint8ArrayToString(challengeRequestPubsubMessage.signature.publicKey, 'base64'),
      }),
    ).to.equal(true)

    // validate publication and publication signature
    expect(challengeRequestPubsubMessage.comment.communityPublicKey).to.equal(communitySigner.address)
    expect(challengeRequestPubsubMessage.comment.content).to.equal(createCommentOptions.content)
    expect(challengeRequestPubsubMessage.comment.title).to.equal(createCommentOptions.title)
    expect(challengeRequestPubsubMessage.comment.timestamp).to.equal(comment.timestamp)
    expect(typeof challengeRequestPubsubMessage.comment.timestamp).to.equal('number')
    expect(challengeRequestPubsubMessage.comment.signature.signedPropertyNames).to.include.members([
      // NOTE: flair and spoiler are not included in author signature because community mods can override it
      // NOTE: author is no longer signed (identity is derived from signature.publicKey)
      'communityPublicKey',
      'timestamp',
      'protocolVersion',
      'title',
      'content',
    ])
    expect(
      await verify({
        objectToSign: challengeRequestPubsubMessage.comment,
        signedPropertyNames: challengeRequestPubsubMessage.comment.signature.signedPropertyNames,
        signature: challengeRequestPubsubMessage.comment.signature.signature,
        publicKey: authorSigner.publicKey,
      }),
    ).to.equal(true)

    // create challenge pusub message
    const challenges = [{challenge: '1+1=?', type: 'text'}]
    const encryptedChallenges = await encryptEd25519AesGcm(
      JSON.stringify({challenges}),
      communitySigner.privateKey,
      uint8ArrayToString(challengeRequestPubsubMessage.signature.publicKey, 'base64'),
    )
    const challengePubsubMessage = {
      type: 'CHALLENGE',
      timestamp: Math.round(Date.now() / 1000),
      challengeRequestId: challengeRequestPubsubMessage.challengeRequestId,
      encrypted: encryptedChallenges,
      protocolVersion: '1.0.0',
      userAgent: `/protocol-test:1.0.0/`,
    }

    // create pubsub challenge message signature
    const challengePubsubMessageSignedPropertyNames = shuffleArray(Object.keys(challengePubsubMessage))
    const challengePubsubMessageSignature = await sign({
      objectToSign: challengePubsubMessage,
      signedPropertyNames: challengePubsubMessageSignedPropertyNames,
      privateKey: communitySigner.privateKey,
    })
    challengePubsubMessage.signature = {
      signature: uint8ArrayFromString(challengePubsubMessageSignature, 'base64'),
      publicKey: uint8ArrayFromString(communitySigner.publicKey, 'base64'),
      type: 'ed25519',
      signedPropertyNames: challengePubsubMessageSignedPropertyNames,
    }
    console.log({challengePubsubMessage})

    // publish challenge pubsub message
    const challengeAnswerPubsubMessage = await publishPubsubMessage(communitySigner.address, challengePubsubMessage)

    // decrypt challenge answers
    challengeAnswerPubsubMessage.challengeAnswers = JSON.parse(
      await decryptEd25519AesGcm(
        challengeAnswerPubsubMessage.encrypted,
        communitySigner.privateKey,
        uint8ArrayToString(challengeRequestPubsubMessage.signature.publicKey, 'base64'),
      ),
    ).challengeAnswers
    console.log({challengeAnswerPubsubMessage})

    // validate challenge answer pubsub message
    expect(challengeAnswerPubsubMessage.type).to.equal('CHALLENGEANSWER')
    expect(challengeAnswerPubsubMessage.encrypted.type).to.equal('ed25519-aes-gcm')
    expect(challengeAnswerPubsubMessage.challengeRequestId.toString()).to.equal(challengeRequestPubsubMessage.challengeRequestId.toString())
    expect(challengeAnswerPubsubMessage.challengeAnswerId).to.equal(undefined)
    expect(challengeAnswerPubsubMessage.challengeAnswers).to.deep.equal(['2'])

    // validate challenge answer pubsub message signature
    expect(challengeAnswerPubsubMessage.signature.type).to.equal('ed25519')
    // the pubsub message signer is the same as the original challenge request id
    expect(challengeAnswerPubsubMessage.signature.publicKey.toString()).to.equal(challengeRequestPubsubMessage.signature.publicKey.toString())
    expect(challengeAnswerPubsubMessage.signature.signedPropertyNames).to.include.members(['type', 'challengeRequestId', 'encrypted'])
    expect(
      await verify({
        objectToSign: challengeAnswerPubsubMessage,
        signedPropertyNames: challengeAnswerPubsubMessage.signature.signedPropertyNames,
        signature: uint8ArrayToString(challengeAnswerPubsubMessage.signature.signature, 'base64'),
        publicKey: uint8ArrayToString(challengeAnswerPubsubMessage.signature.publicKey, 'base64'),
      }),
    ).to.equal(true)

    // create encrypted publication
    const publicationIpfs = {
      ...challengeRequestPubsubMessage.comment,
      depth: 0,
    }
    const publicationIpfsFile = await ipfsClient.add(JSON.stringify(publicationIpfs))
    const commentUpdateVerificationNoSignature = {
      cid: publicationIpfsFile.path,
      protocolVersion: '1.0.0',
      author: {
        community: {
          postScore: 0,
          replyScore: 0,
          firstCommentTimestamp: Math.round(Date.now() / 1000),
          lastCommentCid: publicationIpfsFile.path,
        },
      },
    }
    const commentUpdateVerificationSignedPropertyNames = Object.keys(commentUpdateVerificationNoSignature)
    const commentUpdateVerificationSignature = await sign({
      objectToSign: commentUpdateVerificationNoSignature,
      signedPropertyNames: commentUpdateVerificationSignedPropertyNames,
      privateKey: communitySigner.privateKey,
    })
    const publishedPublication = {
      comment: publicationIpfs,
      commentUpdate: {
        ...commentUpdateVerificationNoSignature,
        signature: {
          signature: commentUpdateVerificationSignature,
          signedPropertyNames: commentUpdateVerificationSignedPropertyNames,
          type: 'ed25519',
          publicKey: communitySigner.publicKey,
        },
      },
    }
    console.log({publishedPublication})
    const encryptedPublishedPublication = await encryptEd25519AesGcm(
      JSON.stringify(publishedPublication),
      communitySigner.privateKey,
      uint8ArrayToString(challengeRequestPubsubMessage.signature.publicKey, 'base64'),
    )

    // create challenge verification pubsub message
    const challengeVerificationPubsubMessage = {
      type: 'CHALLENGEVERIFICATION',
      timestamp: Math.round(Date.now() / 1000),
      challengeRequestId: challengeAnswerPubsubMessage.challengeRequestId,
      challengeSuccess: true,
      encrypted: encryptedPublishedPublication,
      protocolVersion: '1.0.0',
      userAgent: `/protocol-test:1.0.0/`,
    }
    const challengeVerificationPubsubMessageSignedPropertyNames = shuffleArray([
      'type',
      'challengeRequestId',
      'challengeSuccess',
      'timestamp',
      'encrypted',
      'protocolVersion',
      'userAgent',
      'challengeErrors',
      'reason',
    ])
    const challengeVerificationPubsubMessageSignature = await sign({
      objectToSign: challengeVerificationPubsubMessage,
      signedPropertyNames: challengeVerificationPubsubMessageSignedPropertyNames,
      privateKey: communitySigner.privateKey,
    })
    challengeVerificationPubsubMessage.signature = {
      signature: uint8ArrayFromString(challengeVerificationPubsubMessageSignature, 'base64'),
      publicKey: uint8ArrayFromString(communitySigner.publicKey, 'base64'),
      type: 'ed25519',
      signedPropertyNames: challengeVerificationPubsubMessageSignedPropertyNames,
    }
    console.log({challengeVerificationPubsubMessage})

    // publish challenge verification pubsub message
    await publishPubsubMessage(communitySigner.address, challengeVerificationPubsubMessage)
    const challengeVerificationEvent = await challengeVerificationPromise
    await pubsub.unsubscribe()
    console.log({challengeVerificationEvent})

    // validate challenge verification event
    expect(challengeVerificationEvent.challengeSuccess).to.equal(true)
    expect(challengeVerificationEvent.comment).to.deep.equal(publishedPublication.comment)
    expect(challengeVerificationEvent.commentUpdate).to.deep.equal(publishedPublication.commentUpdate)

    // create commentUpdate object
    const commentUpdate = {
      cid: publishedPublication.commentUpdate.cid,
      upvoteCount: 0,
      downvoteCount: 0,
      replyCount: 0,
      updatedAt: Math.round(Date.now() / 1000),
      protocolVersion: '1.0.0',
    }

    // create comment update signature
    const commentUpdateSignedPropertyNames = shuffleArray(Object.keys(commentUpdate))
    const commentUpdateSignature = await sign({
      objectToSign: commentUpdate,
      signedPropertyNames: commentUpdateSignedPropertyNames,
      privateKey: communitySigner.privateKey,
    })
    commentUpdate.signature = {
      signature: commentUpdateSignature,
      publicKey: communitySigner.publicKey,
      type: 'ed25519',
      signedPropertyNames: commentUpdateSignedPropertyNames,
    }
    console.log({commentUpdate})

    // publish post updates folder which contains the comment update
    await ipfsClient.files.write(`/${communitySigner.address}/postUpdates/86400/${publishedPublication.commentUpdate.cid}/update`, JSON.stringify(commentUpdate), {
      parents: true,
      create: true,
      truncate: true,
    })

    const statOfPostUpdatesDirectory = await ipfsClient.files.stat(`/${communitySigner.address}/postUpdates/86400`)
    communityIpns.postUpdates = {
      86400: String(statOfPostUpdatesDirectory.cid),
    }

    const communityIpnsSignatureNewUpdate = await sign({
      objectToSign: communityIpns,
      signedPropertyNames: communityIpnsSignedPropertyNames,
      privateKey: communitySigner.privateKey,
    })
    communityIpns.signature = {
      signature: communityIpnsSignatureNewUpdate,
      publicKey: communitySigner.publicKey,
      type: 'ed25519',
      signedPropertyNames: communityIpnsSignedPropertyNames,
    }
    console.log({communityIpns})

    // publish ipns
    const communityIpnsFile2 = await ipfsClient.add(JSON.stringify(communityIpns))
    await ipfsClient.name.publish(communityIpnsFile2.path, {
      lifetime: '72h',
      key: communitySigner.address, // ipfs key name imported in test server
      allowOffline: true,
    })

    // validate comment update
    const commentUpdatePromise = new Promise((resolve) => {
      comment.on('update', (updatedComment) => {
        console.log('update event')
        // It may emit an update event for CommentIpfs, we need to wait for CommentUpdate
        if (updatedComment.updatedAt) resolve(updatedComment)
      })
    })
    comment.on('error', console.error)
    comment.update().catch(console.error)
    const updatedComment = await commentUpdatePromise

    comment.stop()
    console.log({updatedComment})
    expect(updatedComment.upvoteCount).to.equal(commentUpdate.upvoteCount)
    expect(updatedComment.downvoteCount).to.equal(commentUpdate.downvoteCount)
    expect(typeof updatedComment.updatedAt).to.equal('number')
  })

  it('create vote and publish over pubsub', async () => {
    const communitySigner = signers[0]
    const authorSigner = signers[2]
    const pubsubMessageSigner = await generateSigner()

    expect(publishedCommentCid).to.not.equal(undefined, 'publishedCommentCid gets defined in a previous test, cannot run in .only mode')

    // create vote
    const vote = {
      communityPublicKey: communitySigner.address,
      timestamp: Math.round(Date.now() / 1000),
      protocolVersion: '1.0.0',
      commentCid: publishedCommentCid,
      vote: 1,
    }

    // create vote signature
    const voteSignedPropertyNames = shuffleArray(Object.keys(vote))
    const voteSignature = await sign({
      objectToSign: vote,
      signedPropertyNames: voteSignedPropertyNames,
      privateKey: authorSigner.privateKey,
    })
    vote.signature = {
      signature: voteSignature,
      publicKey: authorSigner.publicKey,
      type: 'ed25519',
      signedPropertyNames: voteSignedPropertyNames,
    }
    console.log({vote})

    // encrypt publication
    const encryptedPublication = await encryptEd25519AesGcm(JSON.stringify({vote}), pubsubMessageSigner.privateKey, communitySigner.publicKey)

    // create pubsub challenge request message
    const challengeRequestPubsubMessage = {
      type: 'CHALLENGEREQUEST',
      timestamp: Math.round(Date.now() / 1000),
      challengeRequestId: await getChallengeRequestIdFromPublicKey(pubsubMessageSigner.publicKey),
      acceptedChallengeTypes: ['image/png'],
      encrypted: encryptedPublication,
      protocolVersion: '1.0.0',
      userAgent: `/protocol-test:1.0.0/`,
    }

    // create pubsub challenge request message signature
    const challengeRequestPubsubMessageSignedPropertyNames = shuffleArray(Object.keys(challengeRequestPubsubMessage))
    const challengeRequestPubsubMessageSignature = await sign({
      objectToSign: challengeRequestPubsubMessage,
      signedPropertyNames: challengeRequestPubsubMessageSignedPropertyNames,
      privateKey: pubsubMessageSigner.privateKey,
    })
    challengeRequestPubsubMessage.signature = {
      signature: uint8ArrayFromString(challengeRequestPubsubMessageSignature, 'base64'),
      publicKey: uint8ArrayFromString(pubsubMessageSigner.publicKey, 'base64'),
      type: 'ed25519',
      signedPropertyNames: challengeRequestPubsubMessageSignedPropertyNames,
    }
    console.log({challengeRequestPubsubMessage})

    // publish pubsub challenge request message
    const challengePubsubMessage = await publishPubsubMessage(communitySigner.address, challengeRequestPubsubMessage)
    console.log({challengePubsubMessage})

    // decrypt challenges
    const challenges = JSON.parse(await decryptEd25519AesGcm(challengePubsubMessage.encrypted, pubsubMessageSigner.privateKey, communitySigner.publicKey)).challenges
    console.log({challenges})

    // validate challenge pubsub message
    expect(challenges[0].challenge).to.equal('1+1=?')
    expect(challenges[0].type).to.equal('text/plain')
    expect(challengePubsubMessage.type).to.equal('CHALLENGE')
    expect(challengePubsubMessage.encrypted.type).to.equal('ed25519-aes-gcm')
    expect(challengePubsubMessage.challengeRequestId.toString()).to.equal(challengeRequestPubsubMessage.challengeRequestId.toString())

    // validate challenge pubsub message community owner signature
    expect(challengePubsubMessage.signature.type).to.equal('ed25519')
    expect(uint8ArrayToString(challengePubsubMessage.signature.publicKey, 'base64')).to.equal(communitySigner.publicKey)
    expect(challengePubsubMessage.signature.signedPropertyNames).to.include.members(['type', 'timestamp', 'challengeRequestId', 'encrypted'])
    expect(
      await verify({
        objectToSign: challengePubsubMessage,
        signedPropertyNames: challengePubsubMessage.signature.signedPropertyNames,
        signature: uint8ArrayToString(challengePubsubMessage.signature.signature, 'base64'),
        publicKey: communitySigner.publicKey,
      }),
    ).to.equal(true)

    // create pubsub challenge answer message
    const challengeAnswers = ['2']
    const encryptedChallengeAnswers = await encryptEd25519AesGcm(JSON.stringify({challengeAnswers}), pubsubMessageSigner.privateKey, communitySigner.publicKey)
    const challengeAnswerPubsubMessage = {
      type: 'CHALLENGEANSWER',
      timestamp: Math.round(Date.now() / 1000),
      challengeRequestId: challengeRequestPubsubMessage.challengeRequestId,
      encrypted: encryptedChallengeAnswers,
      protocolVersion: '1.0.0',
      userAgent: `/protocol-test:1.0.0/`,
    }

    // create pubsub challenge answer message signature
    const challengeAnswerPubsubMessageSignedPropertyNames = shuffleArray(Object.keys(challengeAnswerPubsubMessage))
    const challengeAnswerPubsubMessageSignature = await sign({
      objectToSign: challengeAnswerPubsubMessage,
      signedPropertyNames: challengeAnswerPubsubMessageSignedPropertyNames,
      privateKey: pubsubMessageSigner.privateKey,
    })
    challengeAnswerPubsubMessage.signature = {
      signature: uint8ArrayFromString(challengeAnswerPubsubMessageSignature, 'base64'),
      publicKey: uint8ArrayFromString(pubsubMessageSigner.publicKey, 'base64'),
      type: 'ed25519',
      signedPropertyNames: challengeAnswerPubsubMessageSignedPropertyNames,
    }
    console.log({challengeAnswerPubsubMessage})

    // publish pubsub challenge answer message
    const challengeVerificationPubsubMessage = await publishPubsubMessage(communitySigner.address, challengeAnswerPubsubMessage)
    console.log({challengeVerificationPubsubMessage})

    // validate challenge verification pubsub message
    expect(challengeVerificationPubsubMessage.type).to.equal('CHALLENGEVERIFICATION')
    // no point in sending back encrypted vote in verification
    expect(challengeVerificationPubsubMessage.encrypted).to.equal(undefined)
    expect(challengeVerificationPubsubMessage.challengeSuccess).to.equal(true)
    expect(challengeVerificationPubsubMessage.challengeRequestId.toString()).to.equal(challengeAnswerPubsubMessage.challengeRequestId.toString())
    expect(challengeVerificationPubsubMessage.challengeAnswerId).to.equal(undefined)

    // validate challenge verification pubsub message community owner signature
    expect(challengeVerificationPubsubMessage.signature.type).to.equal('ed25519')
    expect(uint8ArrayToString(challengeVerificationPubsubMessage.signature.publicKey, 'base64')).to.equal(communitySigner.publicKey)
    expect(challengeVerificationPubsubMessage.signature.signedPropertyNames).to.include.members(['type', 'timestamp', 'challengeRequestId', 'challengeSuccess'])
    expect(
      await verify({
        objectToSign: challengeVerificationPubsubMessage,
        signedPropertyNames: challengeVerificationPubsubMessage.signature.signedPropertyNames,
        signature: uint8ArrayToString(challengeVerificationPubsubMessage.signature.signature, 'base64'),
        publicKey: communitySigner.publicKey,
      }),
    ).to.equal(true)
  })

  it('create author comment edit and publish over pubsub', async () => {
    const communitySigner = signers[0]
    const authorSigner = signers[1]
    const pubsubMessageSigner = await generateSigner()

    expect(publishedCommentCid).to.not.equal(undefined, 'publishedCommentCid gets defined in a previous test, cannot run in .only mode')

    // create commend edit
    const commentEdit = {
      communityPublicKey: communitySigner.address,
      timestamp: Math.round(Date.now() / 1000),
      protocolVersion: '1.0.0',
      commentCid: publishedCommentCid,
      content: 'edited content',
      reason: 'edited reason',
    }

    // create commend edit signature
    const commentEditSignedPropertyNames = shuffleArray([
      'communityPublicKey',
      'timestamp',
      'commentCid',
      'content',
      'deleted',
      'flair',
      'spoiler',
      'reason',
      'pinned',
      'locked',
      'removed',
      'protocolVersion',
      'reason',
      'commentAuthor',
    ])
    const commentEditSignature = await sign({
      objectToSign: commentEdit,
      signedPropertyNames: commentEditSignedPropertyNames,
      privateKey: authorSigner.privateKey,
    })
    commentEdit.signature = {
      signature: commentEditSignature,
      publicKey: authorSigner.publicKey,
      type: 'ed25519',
      signedPropertyNames: commentEditSignedPropertyNames,
    }
    console.log({commentEdit})

    // encrypt publication
    const encryptedPublication = await encryptEd25519AesGcm(JSON.stringify({commentEdit}), pubsubMessageSigner.privateKey, communitySigner.publicKey)

    // create pubsub challenge request message
    const challengeRequestPubsubMessage = {
      type: 'CHALLENGEREQUEST',
      timestamp: Math.round(Date.now() / 1000),
      challengeRequestId: await getChallengeRequestIdFromPublicKey(pubsubMessageSigner.publicKey),
      acceptedChallengeTypes: ['image/png'],
      encrypted: encryptedPublication,
      protocolVersion: '1.0.0',
      userAgent: `/protocol-test:1.0.0/`,
    }

    // create pubsub challenge request message signature
    const challengeRequestPubsubMessageSignedPropertyNames = shuffleArray(Object.keys(challengeRequestPubsubMessage))
    const challengeRequestPubsubMessageSignature = await sign({
      objectToSign: challengeRequestPubsubMessage,
      signedPropertyNames: challengeRequestPubsubMessageSignedPropertyNames,
      privateKey: pubsubMessageSigner.privateKey,
    })
    challengeRequestPubsubMessage.signature = {
      signature: uint8ArrayFromString(challengeRequestPubsubMessageSignature, 'base64'),
      publicKey: uint8ArrayFromString(pubsubMessageSigner.publicKey, 'base64'),
      type: 'ed25519',
      signedPropertyNames: challengeRequestPubsubMessageSignedPropertyNames,
    }
    console.log({challengeRequestPubsubMessage})

    // publish pubsub challenge request message
    const challengePubsubMessage = await publishPubsubMessage(communitySigner.address, challengeRequestPubsubMessage)
    console.log({challengePubsubMessage})

    // decrypt challenges
    const challenges = JSON.parse(await decryptEd25519AesGcm(challengePubsubMessage.encrypted, pubsubMessageSigner.privateKey, communitySigner.publicKey)).challenges
    console.log({challenges})

    // validate challenge pubsub message
    expect(challenges[0].challenge).to.equal('1+1=?')
    expect(challenges[0].type).to.equal('text/plain')
    expect(challengePubsubMessage.type).to.equal('CHALLENGE')
    expect(challengePubsubMessage.encrypted.type).to.equal('ed25519-aes-gcm')
    expect(challengePubsubMessage.challengeRequestId.toString()).to.equal(challengeRequestPubsubMessage.challengeRequestId.toString())

    // validate challenge pubsub message community owner signature
    expect(challengePubsubMessage.signature.type).to.equal('ed25519')
    expect(uint8ArrayToString(challengePubsubMessage.signature.publicKey, 'base64')).to.equal(communitySigner.publicKey)
    expect(challengePubsubMessage.signature.signedPropertyNames).to.include.members(['type', 'timestamp', 'challengeRequestId', 'encrypted'])
    expect(
      await verify({
        objectToSign: challengePubsubMessage,
        signedPropertyNames: challengePubsubMessage.signature.signedPropertyNames,
        signature: uint8ArrayToString(challengePubsubMessage.signature.signature, 'base64'),
        publicKey: communitySigner.publicKey,
      }),
    ).to.equal(true)

    // create pubsub challenge answer message
    const challengeAnswers = ['2']
    const encryptedChallengeAnswers = await encryptEd25519AesGcm(JSON.stringify({challengeAnswers}), pubsubMessageSigner.privateKey, communitySigner.publicKey)
    const challengeAnswerPubsubMessage = {
      type: 'CHALLENGEANSWER',
      timestamp: Math.round(Date.now() / 1000),
      challengeRequestId: challengeRequestPubsubMessage.challengeRequestId,
      encrypted: encryptedChallengeAnswers,
      protocolVersion: '1.0.0',
      userAgent: `/protocol-test:1.0.0/`,
    }

    // create pubsub challenge answer message signature
    const challengeAnswerPubsubMessageSignedPropertyNames = shuffleArray(Object.keys(challengeAnswerPubsubMessage))
    const challengeAnswerPubsubMessageSignature = await sign({
      objectToSign: challengeAnswerPubsubMessage,
      signedPropertyNames: challengeAnswerPubsubMessageSignedPropertyNames,
      privateKey: pubsubMessageSigner.privateKey,
    })
    challengeAnswerPubsubMessage.signature = {
      signature: uint8ArrayFromString(challengeAnswerPubsubMessageSignature, 'base64'),
      publicKey: uint8ArrayFromString(pubsubMessageSigner.publicKey, 'base64'),
      type: 'ed25519',
      signedPropertyNames: challengeAnswerPubsubMessageSignedPropertyNames,
    }
    console.log({challengeAnswerPubsubMessage})

    // publish pubsub challenge answer message
    const challengeVerificationPubsubMessage = await publishPubsubMessage(communitySigner.address, challengeAnswerPubsubMessage)
    console.log({challengeVerificationPubsubMessage})

    // validate challenge verification pubsub message
    expect(challengeVerificationPubsubMessage.type).to.equal('CHALLENGEVERIFICATION')
    // no point in sending back encrypted comment edit in verification
    expect(challengeVerificationPubsubMessage.encrypted).to.equal(undefined)
    expect(challengeVerificationPubsubMessage.challengeSuccess).to.equal(true)
    expect(challengeVerificationPubsubMessage.challengeRequestId.toString()).to.equal(challengeAnswerPubsubMessage.challengeRequestId.toString())
    expect(challengeVerificationPubsubMessage.challengeAnswerId).to.equal(undefined)

    // validate challenge verification pubsub message community owner signature
    expect(challengeVerificationPubsubMessage.signature.type).to.equal('ed25519')
    expect(uint8ArrayToString(challengeVerificationPubsubMessage.signature.publicKey, 'base64')).to.equal(communitySigner.publicKey)
    expect(challengeVerificationPubsubMessage.signature.signedPropertyNames).to.include.members(['type', 'timestamp', 'challengeRequestId', 'challengeSuccess'])
    expect(
      await verify({
        objectToSign: challengeVerificationPubsubMessage,
        signedPropertyNames: challengeVerificationPubsubMessage.signature.signedPropertyNames,
        signature: uint8ArrayToString(challengeVerificationPubsubMessage.signature.signature, 'base64'),
        publicKey: communitySigner.publicKey,
      }),
    ).to.equal(true)

    // fetch commentUpdate
    let commentUpdate
    // wait until latest author edit is published (multiple tests use the same comment)
    while (!commentUpdate?.edit || commentUpdate.edit.timestamp !== commentEdit.timestamp) {
      const communityIpfs = await fetchJson(`${ipfsGatewayUrl}/ipns/${commentEdit.communityPublicKey}`)
      commentUpdate = await fetchJson(`${ipfsGatewayUrl}/ipfs/${communityIpfs.postUpdates['86400']}/${commentEdit.commentCid}/update`)
    }
    console.log({commentUpdate})

    // validate author edit
    expect(commentUpdate.edit.commentCid).to.equal(commentEdit.commentCid)
    expect(commentUpdate.edit.reason).to.equal(commentEdit.reason)
    expect(commentUpdate.edit.timestamp).to.equal(commentEdit.timestamp)
    expect(commentUpdate.edit.communityPublicKey).to.equal(commentEdit.communityPublicKey)
    expect(commentUpdate.edit.signature).to.deep.equal(commentEdit.signature)

    // validate author edit signature
    expect(commentUpdate.edit.signature.type).to.equal('ed25519')
    expect(commentUpdate.edit.signature.publicKey).to.equal(authorSigner.publicKey)
    expect(commentUpdate.edit.signature.signedPropertyNames).to.include.members([
      'communityPublicKey',
      'timestamp',
      'commentCid',
      'content',
      'deleted',
      'flair',
      'spoiler',
      'reason',
      'pinned',
      'locked',
      'removed',
      'commentAuthor',
    ])
    expect(
      await verify({
        objectToSign: commentUpdate.edit,
        signedPropertyNames: commentUpdate.edit.signature.signedPropertyNames,
        signature: commentUpdate.edit.signature.signature,
        publicKey: authorSigner.publicKey,
      }),
    ).to.equal(true)
  })

  // TODO: it('community edit and publish over pubsub', async () => {})
})

const getBufferToSign = (objectToSign, signedPropertyNames) => {
  const propsToSign = {}
  for (const propertyName of signedPropertyNames) {
    if (objectToSign[propertyName] !== null && objectToSign[propertyName] !== undefined) {
      propsToSign[propertyName] = objectToSign[propertyName]
    }
  }
  // console.log({propsToSign})
  const bufferToSign = cborg.encode(propsToSign)
  return bufferToSign
}

const sign = async ({objectToSign, signedPropertyNames, privateKey}) => {
  const bufferToSign = getBufferToSign(objectToSign, signedPropertyNames)
  const signatureBuffer = await signBufferEd25519(bufferToSign, privateKey)
  const signatureBase64 = uint8ArrayToString(signatureBuffer, 'base64')
  return signatureBase64
}

const verify = async ({objectToSign, signedPropertyNames, signature, publicKey}) => {
  const bufferToSign = getBufferToSign(objectToSign, signedPropertyNames)
  const signatureAsBuffer = uint8ArrayFromString(signature, 'base64')
  const res = await verifyBufferEd25519(bufferToSign, signatureAsBuffer, publicKey)
  return res
}

const publishPubsubMessage = async (pubsubTopic, messageObject) => {
  let onMessageReceived
  const messageReceivedPromise = new Promise((resolve) => {
    onMessageReceived = async (rawMessageReceived) => {
      const messageReceivedObject = cborg.decode(rawMessageReceived.data)

      // not the message we're looking for
      if (messageObject.challengeRequestId.toString() !== messageReceivedObject.challengeRequestId.toString()) {
        return
      }

      // handle publishing CHALLENGEREQUEST and CHALLENGEANSWER
      if (messageObject.type === 'CHALLENGEREQUEST' || messageObject.type === 'CHALLENGEANSWER') {
        if (messageReceivedObject.type === 'CHALLENGE' || messageReceivedObject.type === 'CHALLENGEVERIFICATION') {
          console.log('unsubscribed from:', pubsubTopic)
          await pubsubIpfsClient.pubsub.unsubscribe(pubsubTopic)
          resolve(messageReceivedObject)
        }
      }

      // handle publishing CHALLENGE
      if (messageObject.type === 'CHALLENGE') {
        if (messageReceivedObject.type === 'CHALLENGEANSWER') {
          resolve(messageReceivedObject)
        }
      }
    }
  })

  await pubsubIpfsClient.pubsub.subscribe(pubsubTopic, onMessageReceived)
  console.log('subscribed to:', pubsubTopic)

  const message = cborg.encode(messageObject)
  await pubsubIpfsClient.pubsub.publish(pubsubTopic, message)
  console.log('published message:', messageObject.type)

  // handle publishing CHALLENGEVERIFICATION
  if (messageObject.type === 'CHALLENGEVERIFICATION') {
    return
  }

  const messageReceived = await messageReceivedPromise
  return messageReceived
}

const pubsubSubscribe = async (pubsubTopic) => {
  let getMessageResolve = () => {}

  const onMessageReceived = async (rawMessageReceived) => {
    await sleep(100) // need to sleep or doesn't work for some reason

    const messageReceivedObject = cborg.decode(rawMessageReceived.data)
    if (messageReceivedObject.type === 'CHALLENGEREQUEST' || messageReceivedObject.type === 'CHALLENGEANSWER') {
      getMessageResolve(messageReceivedObject)
    }
  }

  await pubsubIpfsClient.pubsub.subscribe(pubsubTopic, onMessageReceived)
  console.log('subscribed to:', pubsubTopic)

  return {
    getMessage: async () => {
      // every time getMessage is called, replace the resolve function with the latest
      const getMessagePromise = new Promise((resolve) => {
        getMessageResolve = resolve
      })
      const message = await getMessagePromise
      return message
    },
    unsubscribe: async () => {
      await pubsubIpfsClient.pubsub.unsubscribe(pubsubTopic)
      console.log('unsubscribed from:', pubsubTopic)
    },
  }
}

const getRandomString = () => (Math.random() + 1).toString(36).replace('.', '')

function shuffleArray(array) {
  array = [...array]
  for (var i = array.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1))
    var temp = array[i]
    array[i] = array[j]
    array[j] = temp
  }
  return array
}

const fetchJson = async (url) => {
  const _fetchJson = () =>
    fetch(url, {
      cache: 'no-cache',
    }).then(async (res) => {
      const text = await res.text()
      try {
        const json = JSON.parse(text)
        return json
      } catch (e) {
        e.message += `: fetch response status '${res.status}' body '${text}'`
        throw e
      }
    })

  // retry because ipns takes some time to load
  let maxRetries = 20
  while (true) {
    try {
      const res = await _fetchJson(url)
      return res
    } catch (e) {
      if (maxRetries-- === 0) {
        throw e
      }
      await new Promise((r) => setTimeout(r, 1000)) // sleep
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
