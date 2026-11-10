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

// start an offline ipfs daemon with startIpfs in a child node process, like test/test-server/index.js does
const startIpfsInChildProcess = async ({exitWhenReady = false} = {}) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkc-protocol-test-start-ipfs-'))
  const apiPort = await getFreePort()
  const gatewayPort = await getFreePort()
  const script = `
    const {startIpfs} = await import(${JSON.stringify(startIpfsUrl)})
    await startIpfs({apiPort: ${apiPort}, gatewayPort: ${gatewayPort}, args: '--offline'})
    console.log('startIpfs resolved')
    ${exitWhenReady ? 'process.exit(0)' : 'setInterval(() => {}, 1000)'}
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {env: {...process.env, TMPDIR: tmpDir}})
  // 'close' fires after the child exited and its output was read
  const childExited = new Promise((resolve) => child.once('close', (code, signal) => resolve({code, signal})))
  const handle = {child, childExited, tmpDir, daemonPid: undefined}
  started.push(handle)

  let output = ''
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error(`startIpfs didn't resolve in the child process, output:\n${output}`)), 60000)
    const onData = (data) => {
      output += data
      handle.daemonPid ??= Number(output.match(/process started with pid (\d+)/)?.[1]) || undefined
      if (output.includes('startIpfs resolved')) {
        clearTimeout(timeout)
        resolve()
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    childExited.then(() => {
      clearTimeout(timeout)
      output.includes('startIpfs resolved') ? resolve() : reject(Error(`child process exited before startIpfs resolved, output:\n${output}`))
    })
  })
  expect(handle.daemonPid).to.be.a('number')
  return handle
}

describe('test server (node)', () => {
  afterEach(async () => {
    // never leave a daemon running, even when a test fails
    for (const {child, daemonPid, tmpDir} of started.splice(0)) {
      child.kill('SIGKILL')
      if (daemonPid && isProcessRunning(daemonPid)) {
        process.kill(daemonPid, 'SIGKILL')
        await waitForProcessToStop(daemonPid)
      }
      fs.rmSync(tmpDir, {recursive: true, force: true})
    }
  })

  for (const signal of ['SIGTERM', 'SIGINT']) {
    it(`stops the ipfs daemon when the test server gets ${signal}`, async () => {
      const {child, childExited, daemonPid} = await startIpfsInChildProcess()
      expect(isProcessRunning(daemonPid)).to.equal(true)

      child.kill(signal)
      await childExited
      expect(await waitForProcessToStop(daemonPid)).to.equal(true, `ipfs daemon pid ${daemonPid} still running after the test server got ${signal}`)
    })
  }

  it('stops the ipfs daemon when the test server exits', async () => {
    const {childExited, daemonPid} = await startIpfsInChildProcess({exitWhenReady: true})

    await childExited
    expect(await waitForProcessToStop(daemonPid)).to.equal(true, `ipfs daemon pid ${daemonPid} still running after the test server exited`)
  })
})
