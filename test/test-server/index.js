// script to start IPFS and pkc-js for testing

;(await import('util')).inspect.defaultOptions.depth = null
import PKC from '@pkcprotocol/pkc-js'
import {directory as getTmpFolderPath} from 'tempy'
import {startIpfs} from './start-ipfs.js'
import {offlineIpfs, pubsubIpfs} from './ipfs-config.js'
import signers from '../fixtures/signers.js'
import {ipfsKeyImport} from '../utils/ipfs.js'
import http from 'http'

// always use the same private key and community address when testing
const privateKey = signers[0].privateKey
const pkcDataPath = getTmpFolderPath()

// set up a community for testing
;(async () => {
  await startIpfs(offlineIpfs)
  await startIpfs(pubsubIpfs)

  const pkcOptions = {
    kuboRpcClientsOptions: [`http://127.0.0.1:${offlineIpfs.apiPort}/api/v0`],
    pubsubKuboRpcClientsOptions: [`http://127.0.0.1:${pubsubIpfs.apiPort}/api/v0`],
    httpRoutersOptions: [],
    // pubsubHttpClientOptions: `https://pubsubprovider.xyz/api/v0`,
    dataPath: pkcDataPath,
    publishInterval: 1000,
    updateInterval: 1000,
  }

  // import all keys to ipfs here because the import key api is buggy
  for (const signer of signers) {
    await ipfsKeyImport({
      // use the signer address as the key name to use in the tests
      keyName: signer.address,
      privateKey: signer.privateKey,
      ipfsHttpUrl: pkcOptions.kuboRpcClientsOptions[0],
    })
  }

  const pkc = await PKC(pkcOptions)
  pkc.on('error', console.log)
  const remotePkc = await PKC({...pkcOptions, dataPath: undefined})
  remotePkc.on('error', console.log)
  const signer = await pkc.createSigner({privateKey, type: 'ed25519'})

  console.log(`creating community with address '${signer.address}'...`)
  const community = await pkc.createCommunity({
    signer,
    title: 'community title',
  })
  community.on('challengerequest', console.log)
  community.on('challengeanswer', console.log)
  await community.edit({settings: {challenges: [{name: 'question', options: {question: '1+1=?', answer: '2'}}]}})
  console.log('community created')

  console.log('starting community...')
  await community.start()
  community.once('update', async () => {
    console.log(`community started with address ${signer.address}`)

    console.log('publish test comment')
    const comment = await remotePkc.createComment({
      title: 'comment title',
      content: 'comment content',
      communityAddress: signer.address,
      signer,
    })
    comment.once('challenge', () => comment.publishChallengeAnswers(['2']))

    await comment.publish()
    console.log('test comment published')
    console.log('test server ready')

    // create a test server to be able to use npm module 'wait-on'
    // to know when the test server is finished getting ready
    // and able to start the automated tests
    http
      .createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.end('test server ready')
      })
      .listen(59281)
  })
})()
