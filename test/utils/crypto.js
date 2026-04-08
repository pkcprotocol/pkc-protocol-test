import * as ed from '@noble/ed25519'
import {fromString as uint8ArrayFromString} from 'uint8arrays/from-string'
import {toString as uint8ArrayToString} from 'uint8arrays/to-string'
import {Ed25519PublicKey, Ed25519PrivateKey} from 'libp2p-crypto/src/keys/ed25519-class.js'
import assert from 'assert'
import PeerId from 'peer-id'

const generatePrivateKey = async () => {
  const privateKeyBuffer = ed.utils.randomPrivateKey()
  const privateKeyBase64 = uint8ArrayToString(privateKeyBuffer, 'base64')
  return privateKeyBase64
}

const getPublicKeyFromPrivateKey = async (privateKeyBase64) => {
  assert(privateKeyBase64 && typeof privateKeyBase64 === 'string', `getPublicKeyFromPrivateKey privateKeyBase64 not a string`)
  const privateKeyBuffer = uint8ArrayFromString(privateKeyBase64, 'base64')
  assert.equal(privateKeyBuffer.length, 32, `getPublicKeyFromPrivateKey privateKeyBase64 ed25519 private key length not 32 bytes (${privateKeyBuffer.length} bytes)`)
  const publicKeyBuffer = await ed.getPublicKey(privateKeyBuffer)
  return uint8ArrayToString(publicKeyBuffer, 'base64')
}

const getIpfsKeyFromPrivateKey = async (privateKeyBase64) => {
  assert(privateKeyBase64 && typeof privateKeyBase64 === 'string', `getIpfsKeyFromPrivateKey privateKeyBase64 not a string`)
  const privateKeyBuffer = uint8ArrayFromString(privateKeyBase64, 'base64')
  assert.equal(privateKeyBuffer.length, 32, `getIpfsKeyFromPrivateKey privateKeyBase64 ed25519 private key length not 32 bytes (${privateKeyBuffer.length} bytes)`)
  const publicKeyBuffer = await ed.getPublicKey(privateKeyBuffer)

  // ipfs ed25519 private keys format are private (32 bytes) + public (32 bytes) (64 bytes total)
  const privateAndPublicKeyBuffer = new Uint8Array(64)
  privateAndPublicKeyBuffer.set(privateKeyBuffer)
  privateAndPublicKeyBuffer.set(publicKeyBuffer, 32)

  const ed25519PrivateKeyInstance = new Ed25519PrivateKey(privateAndPublicKeyBuffer, publicKeyBuffer)
  // the "ipfs key" adds a suffix, then the private key, then the public key, it is not the raw private key
  return ed25519PrivateKeyInstance.bytes
}

const getPeerIdFromPrivateKey = async (privateKeyBase64) => {
  const ipfsKey = await getIpfsKeyFromPrivateKey(privateKeyBase64)
  // the PeerId private key is not a raw private key, it's an "ipfs key"
  const peerId = await PeerId.createFromPrivKey(ipfsKey)
  return peerId
}

const getPeerIdFromPublicKey = async (publicKeyBase64) => {
  assert(publicKeyBase64 && typeof publicKeyBase64 === 'string', `getPeerIdFromPublicKey publicKeyBase64 '${publicKeyBase64}' not a string`)
  const publicKeyBuffer = uint8ArrayFromString(publicKeyBase64, 'base64')
  assert.equal(
    publicKeyBuffer.length,
    32,
    `getPeerIdFromPublicKey publicKeyBase64 '${publicKeyBase64}' ed25519 public key length not 32 bytes (${publicKeyBuffer.length} bytes)`,
  )

  // the PeerId public key is not a raw public key, it adds a suffix
  const ed25519PublicKeyInstance = new Ed25519PublicKey(publicKeyBuffer)
  const peerId = await PeerId.createFromPubKey(ed25519PublicKeyInstance.bytes)
  return peerId
}

const getChallengeRequestIdFromPublicKey = async (publicKeyBase64) => {
  const peerId = await getPeerIdFromPublicKey(publicKeyBase64)
  return peerId.toBytes()
}

const getPkcAddressFromPrivateKey = async (privateKeyBase64) => {
  const peerId = await getPeerIdFromPrivateKey(privateKeyBase64)
  return peerId.toB58String().trim()
}

const getPkcAddressFromPublicKey = async (publicKeyBase64) => {
  const peerId = await getPeerIdFromPublicKey(publicKeyBase64)
  return peerId.toB58String().trim()
}

const generateSigner = async () => {
  const privateKey = await generatePrivateKey()
  return {
    privateKey,
    publicKey: await getPublicKeyFromPrivateKey(privateKey),
    address: await getPkcAddressFromPrivateKey(privateKey),
    type: 'ed25519',
  }
}

export {
  generatePrivateKey,
  getPublicKeyFromPrivateKey,
  getIpfsKeyFromPrivateKey,
  getPeerIdFromPrivateKey,
  getPeerIdFromPublicKey,
  getPkcAddressFromPrivateKey,
  getPkcAddressFromPublicKey,
  getChallengeRequestIdFromPublicKey,
  generateSigner,
}
