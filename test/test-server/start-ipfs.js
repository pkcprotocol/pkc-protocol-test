// script to start IPFS and pkc-js for testing

import {execSync, spawn} from 'child_process'
import {directory as getTmpFolderPath} from 'tempy'
import {path as ipfsPathFunc} from 'kubo'
import assert from 'assert'
import os from 'os'

const ipfsPath = ipfsPathFunc()

const ipfsProcesses = new Set()
let stopping = false

// stop the ipfs daemons and wait until they exited before exiting, so their ports are free once the test server is gone.
// SIGKILL because kubo's graceful shutdown waits for the api requests pkc-js keeps open in this process, and the
// daemons only use throwaway repos
const stopIpfsDaemonsAndExit = async (exitCode) => {
  if (stopping) {
    return
  }
  stopping = true
  // pkc-js requests to the daemons fail from now on, don't let that crash the test server before they exited
  process.on('unhandledRejection', () => {})
  const ipfsProcessesExited = [...ipfsProcesses].map((ipfsProcess) => new Promise((resolve) => ipfsProcess.once('exit', resolve)))
  for (const ipfsProcess of ipfsProcesses) {
    ipfsProcess.kill('SIGKILL')
  }
  await Promise.race([Promise.all(ipfsProcessesExited), new Promise((resolve) => setTimeout(resolve, 10000))])
  process.exit(exitCode)
}

// SIGINT and SIGTERM don't emit 'exit'
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stopIpfsDaemonsAndExit(128 + os.constants.signals[signal]))
}
// an uncaught error (also an unhandled rejection) would exit right away, report it and exit once the daemons exited
process.on('uncaughtException', (error) => {
  console.error(error)
  stopIpfsDaemonsAndExit(1)
})
// 'exit' handlers can't wait, so on any other exit (e.g. process.exit) only signal the daemons, they stop
// gracefully once this process and its api requests are gone
process.on('exit', () => {
  for (const ipfsProcess of ipfsProcesses) {
    ipfsProcess.kill()
  }
})

export const startIpfs = ({apiPort, gatewayPort, args = ''} = {}) => {
  assert.equal(typeof apiPort, 'number')
  assert.equal(typeof gatewayPort, 'number')

  const ipfsDataPath = getTmpFolderPath()
  const pkcDataPath = getTmpFolderPath()
  // init ipfs binary
  try {
    execSync(`IPFS_PATH=${ipfsDataPath} ${ipfsPath} init`, {stdio: 'inherit'})
  } catch (e) {}

  // allow * origin on ipfs api to bypass cors browser error
  // very insecure do not do this in production
  execSync(`IPFS_PATH=${ipfsDataPath} ${ipfsPath} config --json API.HTTPHeaders.Access-Control-Allow-Origin '["*"]'`, {stdio: 'inherit'})

  // set ports
  execSync(`IPFS_PATH=${ipfsDataPath} ${ipfsPath} config Addresses.API /ip4/127.0.0.1/tcp/${apiPort}`, {stdio: 'inherit'})
  execSync(`IPFS_PATH=${ipfsDataPath} ${ipfsPath} config Addresses.Gateway /ip4/127.0.0.1/tcp/${gatewayPort}`, {stdio: 'inherit'})

  // set gateway to not use subdomains
  execSync(`IPFS_PATH=${ipfsDataPath} ${ipfsPath} config --json Gateway.PublicGateways '{"localhost": {"UseSubdomains": false, "Paths": ["/ipfs", "/ipns"]}}'`, {
    stdio: 'inherit',
  })

  // start ipfs daemon, without a shell so ipfsProcess.pid is the daemon's pid
  const ipfsArgs = ['daemon', ...args.split(' ').filter(Boolean)]
  const ipfsProcess = spawn(ipfsPath, ipfsArgs, {env: {...process.env, IPFS_PATH: ipfsDataPath}})
  ipfsProcess.stdout.setEncoding('utf8')
  ipfsProcess.stderr.setEncoding('utf8')
  console.log(`IPFS_PATH=${ipfsDataPath} ${ipfsPath} ${ipfsArgs.join(' ')} process started with pid ${ipfsProcess.pid}`)
  ipfsProcess.stderr.on('data', console.error)
  ipfsProcess.stdin.on('data', console.log)
  ipfsProcess.stdout.on('data', console.log)
  ipfsProcess.on('error', console.error)
  ipfsProcesses.add(ipfsProcess)
  ipfsProcess.on('exit', () => {
    ipfsProcesses.delete(ipfsProcess)
    console.error(`ipfs process with pid ${ipfsProcess.pid} exited`)
    stopIpfsDaemonsAndExit(1)
  })

  const ipfsDaemonIsReady = () =>
    new Promise((resolve) => {
      ipfsProcess.stdout.on('data', (data) => {
        if (data.match('Daemon is ready')) {
          resolve()
        }
      })
    })

  return ipfsDaemonIsReady()
}
