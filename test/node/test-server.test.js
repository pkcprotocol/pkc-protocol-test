import {afterEach, describe, expect, it} from 'vitest'
import {spawn} from 'child_process'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'

// the test server must stop its ipfs daemons when it stops, otherwise they keep the fixed
// ipfs ports and the next test server can't start

const startIpfsUrl = new URL('../test-server/start-ipfs.js', import.meta.url).href

const getFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address()
      server.close(() => resolve(port))
    })
  })

const isProcessRunning = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

const waitForProcessToStop = async (pid, timeout = 20000) => {
  const start = Date.now()
  while (isProcessRunning(pid) && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 100))
  }
  return !isProcessRunning(pid)
}

const started = []

// start offline ipfs daemons with startIpfs in a child node process, like test/test-server/index.js does,
// then run whenReady in it
const startIpfsInChildProcess = async ({daemons = 1, whenReady = 'setInterval(() => {}, 1000)'} = {}) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkc-protocol-test-start-ipfs-'))
  const ports = []
  for (let i = 0; i < daemons; i++) {
    ports.push({apiPort: await getFreePort(), gatewayPort: await getFreePort()})
  }
  const script = `
    const http = await import('http')
    const {startIpfs} = await import(${JSON.stringify(startIpfsUrl)})
    for (const {apiPort, gatewayPort} of ${JSON.stringify(ports)}) {
      await startIpfs({apiPort, gatewayPort, args: '--offline'})
      // keep a streaming api request open, like the pubsub subscriptions of pkc-js in the test server
      await new Promise((resolve) => http.request({host: '127.0.0.1', port: apiPort, path: '/api/v0/log/tail', method: 'POST'}).on('error', () => {}).on('finish', resolve).end())
    }
    console.log('startIpfs resolved')
    ${whenReady}
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {env: {...process.env, TMPDIR: tmpDir}})
  // 'close' fires after the child exited and its output was read
  const childExited = new Promise((resolve) => child.once('close', (code, signal) => resolve({code, signal})))
  let output = ''
  const handle = {child, childExited, tmpDir, daemonPids: [], getOutput: () => output}
  started.push(handle)

  let stdout = ''
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error(`startIpfs didn't resolve in the child process, output:\n${output}`)), 60000)
    const onData = (data) => {
      output += data
      if (output.includes('startIpfs resolved')) {
        clearTimeout(timeout)
        resolve()
      }
    }
    child.stdout.on('data', (data) => {
      // only read pids from complete stdout lines, a chunk can end in the middle of a pid
      stdout += data
      handle.daemonPids = [...stdout.matchAll(/process started with pid (\d+)\n/g)].map((match) => Number(match[1]))
      onData(data)
    })
    child.stderr.on('data', onData)
    childExited.then(() => {
      clearTimeout(timeout)
      output.includes('startIpfs resolved') ? resolve() : reject(Error(`child process exited before startIpfs resolved, output:\n${output}`))
    })
  })
  expect(handle.daemonPids).to.have.length(daemons)
  return handle
}

describe('test server (node)', () => {
  afterEach(async () => {
    // never leave a daemon running, even when a test fails
    for (const {child, daemonPids, tmpDir} of started.splice(0)) {
      child.kill('SIGKILL')
      for (const daemonPid of daemonPids) {
        if (isProcessRunning(daemonPid)) {
          process.kill(daemonPid, 'SIGKILL')
          await waitForProcessToStop(daemonPid)
        }
      }
      fs.rmSync(tmpDir, {recursive: true, force: true})
    }
  })

  // the daemons must be gone when the test server is gone, so a test server started right after can bind their ports
  for (const signal of ['SIGTERM', 'SIGINT']) {
    it(`stops the ipfs daemons before exiting when the test server gets ${signal}`, async () => {
      const {child, childExited, daemonPids} = await startIpfsInChildProcess({daemons: 2})
      for (const daemonPid of daemonPids) {
        expect(isProcessRunning(daemonPid)).to.equal(true)
      }

      const signaledAt = Date.now()
      child.kill(signal)
      expect(await childExited).to.deep.equal({code: 128 + os.constants.signals[signal], signal: null})
      // kubo's graceful shutdown waits for open api requests, so the test server must not wait for it
      expect(Date.now() - signaledAt).to.be.below(5000, `test server took too long to exit on ${signal}`)
      for (const daemonPid of daemonPids) {
        expect(isProcessRunning(daemonPid)).to.equal(false, `ipfs daemon pid ${daemonPid} still running after the test server exited on ${signal}`)
      }
    })
  }

  it('stops the other ipfs daemon before exiting when an ipfs daemon exits', async () => {
    const {childExited, daemonPids} = await startIpfsInChildProcess({daemons: 2})
    const [exitedDaemonPid, otherDaemonPid] = daemonPids

    const killedAt = Date.now()
    process.kill(exitedDaemonPid, 'SIGKILL')
    expect(await childExited).to.deep.equal({code: 1, signal: null})
    expect(Date.now() - killedAt).to.be.below(5000, 'test server took too long to exit after an ipfs daemon exited')
    expect(isProcessRunning(otherDaemonPid)).to.equal(false, `ipfs daemon pid ${otherDaemonPid} still running after the test server exited`)
  })

  // test/test-server/index.js has no catch, so a failed startup step is an unhandled rejection
  const fatalErrors = {
    'uncaught exception': "setTimeout(() => { throw Error('fatal test server error') })",
    'unhandled rejection': "Promise.reject(Error('fatal test server error'))",
  }
  for (const [fatalError, whenReady] of Object.entries(fatalErrors)) {
    it(`stops the ipfs daemons before exiting when the test server has an ${fatalError}`, async () => {
      const {childExited, daemonPids, getOutput} = await startIpfsInChildProcess({daemons: 2, whenReady})
      const readyAt = Date.now()
      expect(await childExited).to.deep.equal({code: 1, signal: null})
      expect(Date.now() - readyAt).to.be.below(5000, `test server took too long to exit on an ${fatalError}`)
      expect(getOutput()).to.include('fatal test server error')
      for (const daemonPid of daemonPids) {
        expect(isProcessRunning(daemonPid)).to.equal(false, `ipfs daemon pid ${daemonPid} still running after the test server exited on an ${fatalError}`)
      }
    })
  }

  // 'exit' handlers can't wait, so on process.exit the daemon is only signaled
  it('stops the ipfs daemon when the test server exits', async () => {
    const {childExited, daemonPids} = await startIpfsInChildProcess({whenReady: 'process.exit(0)'})
    const [daemonPid] = daemonPids

    await childExited
    expect(await waitForProcessToStop(daemonPid)).to.equal(true, `ipfs daemon pid ${daemonPid} still running after the test server exited`)
  })
})
