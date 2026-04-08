// the test server can crash without logs, this script adds logs when this happens
// you should also import assertTestServerDidntCrash and run it beforeEach and afterEach

import {offlineIpfs, pubsubIpfs} from './ipfs-config.js'

// make sure only one instance is running in node
let started = false
const startMonitoring = async () => {
  if (started) {
    return
  }
  started = true

  // log when test server or ipfs crashes
  setInterval(async () => {
    logTestServerCrashed()
  }, 200).unref?.()
}

// make sure only one instance is running in browser environments (Playwright)
try {
  if (!window.PKC_MONITOR_TEST_SERVER_STARTED) {
    startMonitoring()
  }
  window.PKC_MONITOR_TEST_SERVER_STARTED = true
} catch (e) {}
startMonitoring()

const logTestServerCrashed = async () => {
  try {
    await assertTestServerDidntCrash()
  } catch (e) {
    console.error(e.message)
  }
}

export const assertTestServerDidntCrash = async () => {
  const testServerRes = await fetchText('http://127.0.0.1:59281')
  if (!testServerRes?.ok || testServerRes.text !== 'test server ready') {
    throw Error('test server crashed http://127.0.0.1:59281')
  }
  const offlineIpfsRes = await fetchText(`http://127.0.0.1:${offlineIpfs.gatewayPort}/ipfs/QmQPeNsJPyVWPFDVHb77w8G42Fvo15z4bG2X8D2GhfbSXc/readme`)
  if (!offlineIpfsRes) {
    throw Error(`test server crashed offline ipfs daemon http://127.0.0.1:${offlineIpfs.gatewayPort}`)
  }
  if (offlineIpfsRes.status >= 500) {
    throw Error(`test server crashed offline ipfs daemon http://127.0.0.1:${offlineIpfs.gatewayPort} (status ${offlineIpfsRes.status})`)
  }
  if (offlineIpfsRes.ok && !offlineIpfsRes.text?.startsWith('Hello and Welcome to IPFS')) {
    console.warn(`Unexpected offline IPFS gateway response for readme:`, offlineIpfsRes.text?.slice(0, 80))
  }
  const pubsubIpfsRes = await fetchText(`http://127.0.0.1:${pubsubIpfs.gatewayPort}/ipfs/QmQPeNsJPyVWPFDVHb77w8G42Fvo15z4bG2X8D2GhfbSXc/readme`)
  if (!pubsubIpfsRes) {
    throw Error(`test server crashed pubsub ipfs daemon http://127.0.0.1:${pubsubIpfs.gatewayPort}`)
  }
  if (pubsubIpfsRes.status >= 500) {
    throw Error(`test server crashed pubsub ipfs daemon http://127.0.0.1:${pubsubIpfs.gatewayPort} (status ${pubsubIpfsRes.status})`)
  }
  if (pubsubIpfsRes.ok && !pubsubIpfsRes.text?.startsWith('Hello and Welcome to IPFS')) {
    console.warn(`Unexpected pubsub IPFS gateway response for readme:`, pubsubIpfsRes.text?.slice(0, 80))
  }
}

const fetchText = async (url) => {
  try {
    const res = await fetch(url, {cache: 'no-cache'})
    const resText = await res.text()
    return {text: resText, status: res.status, ok: res.ok}
  } catch (e) {
    console.error(`Error for fetch url`, url, e)
  }
  return undefined
}
