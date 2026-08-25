const fs = require('fs')
const path = require('path')

const tmpPath = require('os').tmpdir()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function warmup() {
  const generateConfig = require('./generateConfig')
  const keyFile = path.resolve(tmpPath, 'xeapi_public_key')
  const tokenFile = path.resolve(tmpPath, 'anonymous_token')
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      await generateConfig()
    } catch (error) {
      console.log('[start] warmup error:', error)
    }
    const keyReady =
      fs.existsSync(keyFile) && fs.statSync(keyFile).size > 0
    const tokenReady =
      fs.existsSync(tokenFile) && fs.statSync(tokenFile).size > 0
    if (keyReady && tokenReady) {
      console.log('[start] anonymous token & xeapi public key ready')
      return
    }
    await sleep(5000)
  }
  console.log('[start] warmup incomplete, starting server anyway')
}

async function main() {
  require('./main')
  warmup()
  require('./server').serveNcmApi({ checkVersion: false })
}

main()
