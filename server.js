/**
 * server.js
 * Minimal Express server for MarketHub
 *
 * - Serves static files from /public
 * - Endpoints:
 *    POST /api/auth/verify      -> validate Telegram initData (light)
 *    GET  /api/nfts             -> list NFTs
 *    POST /api/nft/buy          -> buy NFT using internal balance
 *    POST /api/admin/add_balance-> admin issues balance
 *    POST /api/sync-nfts        -> (manual) sync mock incoming NFT -> create t.me/nft link
 *    POST /api/ton/purchase     -> (optional) TonConnect callback mock
 *
 * Environment (.env):
 *   PORT
 *   TELEGRAM_BOT_TOKEN
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   JWT_SECRET
 *   ADMIN_TELEGRAM_ID (default 6828395702)
 *
 * NOTE:
 *  - Use SUPABASE_SERVICE_ROLE_KEY only on server & never publish it publicly.
 *  - `sync-nfts` here is a placeholder: replace with real worker that watches TON/Telegram transactions.
 */

const express = require('express')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const crypto = require('crypto')
const fetch = require('node-fetch')
const cheerio = require('cheerio')
require('dotenv').config()

const { createClient } = require('@supabase/supabase-js')
const jwt = require('jsonwebtoken')

const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())

const PORT = process.env.PORT || 3000
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const JWT_SECRET = process.env.JWT_SECRET || 'change-me'
const ADMIN_TELEGRAM_ID = (process.env.ADMIN_TELEGRAM_ID || '6828395702').toString()

let supabase = null
let useSupabase = false
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  useSupabase = true
  console.log('Supabase: enabled')
} else {
  console.log('Supabase: disabled (running with in-memory mock)')
}

// ========== In-memory fallback DB ==========
const mockDB = {
  profiles: {
    // example
    '12345678': { id: '12345678', first_name: 'Demo', username: 'demo_user', premium_until: null, stars_balance: 0 }
  },
  balances: {
    '12345678': 20.0 // internal balance in TON
  },
  nfts: [
    // example NFTs (image_url can be updated by sync)
    { id: 1, name: 'Desk Calendar', number: 4567, price: 2.5, link: 'https://t.me/nft/DeskCalendar-4567', image_url: '/assets/placeholder1.png', owner_id: null },
    { id: 2, name: 'Abstract Soul', number: 12, price: 1.2, link: 'https://t.me/nft/AbstractSoul-12', image_url: '/assets/placeholder2.png', owner_id: null },
    { id: 3, name: 'Blue Planet', number: 77, price: 3.0, link: 'https://t.me/nft/BluePlanet-77', image_url: '/assets/placeholder3.png', owner_id: null },
    { id: 4, name: 'Fragment #9', number: 9, price: 0.5, link: 'https://t.me/nft/Fragment-9', image_url: '/assets/placeholder4.png', owner_id: null }
  ],
  gifts: []
}

// ========= Helper: parse Telegram initData query-string =========
function parseQueryString(qs) {
  const pairs = String(qs).split('&').filter(Boolean)
  const obj = {}
  for (const p of pairs) {
    const idx = p.indexOf('=')
    if (idx === -1) continue
    const k = decodeURIComponent(p.slice(0, idx))
    const v = decodeURIComponent(p.slice(idx + 1))
    obj[k] = v
  }
  return obj
}

// Validate Telegram WebApp initData (follow Telegram docs)
function checkInitData(initDataString) {
  if (!TELEGRAM_BOT_TOKEN) return false // can't validate without bot token
  try {
    const params = parseQueryString(initDataString)
    const hash = params.hash
    if (!hash) return false
    // build data_check_string
    const items = []
    Object.keys(params).filter(k => k !== 'hash').sort().forEach(k => items.push(`${k}=${params[k]}`))
    const dataCheckString = items.join('\n')
    // secret key: HMAC-SHA256 of bot token using key 'WebAppData' per earlier pattern
    const secret = crypto.createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest()
    const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex')
    return hmac === hash
  } catch (e) {
    console.error('checkInitData err', e)
    return false
  }
}

// ============= Serve static files =============
app.use('/', express.static('public', { extensions: ['html'] }))
app.use('/assets', express.static('public/assets'))

// ============= API: auth verify =============
app.post('/api/auth/verify', async (req, res) => {
  const { initData } = req.body
  if (!initData) return res.status(400).json({ ok: false, error: 'missing initData' })

  const valid = checkInitData(initData)
  if (!valid) return res.status(401).json({ ok: false, error: 'invalid initData' })

  // parse user (initData may include user field)
  const params = parseQueryString(initData)
  let user = null
  if (params.user) {
    try { user = JSON.parse(params.user) } catch (e) { user = null }
  }

  if (user && useSupabase) {
    // upsert basic profile on server
    try {
      await supabase.from('profiles').upsert({
        id: user.id.toString(),
        first_name: user.first_name || null,
        username: user.username || null
      }, { onConflict: ['id'] })
    } catch (e) {
      console.warn('supabase upsert profile failed', e)
    }
  } else if (user) {
    mockDB.profiles[user.id] = mockDB.profiles[user.id] || { id: user.id.toString(), first_name: user.first_name, username: user.username, premium_until: null, stars_balance: 0 }
  }

  // create app JWT (short-lived)
  const token = jwt.sign({ sub: user ? user.id : 'anon' }, JWT_SECRET, { expiresIn: '1h' })

  return res.json({ ok: true, user, token })
})

// ============= API: list NFTs =============
app.get('/api/nfts', async (req, res) => {
  if (useSupabase) {
    try {
      const { data, error } = await supabase.from('nfts').select('*')
      if (error) return res.status(500).json({ ok: false, error })
      return res.json({ ok: true, nfts: data })
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) })
    }
  } else {
    return res.json({ ok: true, nfts: mockDB.nfts })
  }
})

// ============= API: buy NFT (using internal balance) =============
/**
 * body: { token (optional), buyer_id, nft_id }
 * - Verify buyer_id (for production: use token/session)
 * - Check balance; if enough, deduct and set owner_id
 */
app.post('/api/nft/buy', async (req, res) => {
  const { buyer_id, nft_id } = req.body
  if (!buyer_id || typeof nft_id === 'undefined') return res.status(400).json({ ok: false, error: 'missing buyer_id or nft_id' })

  const userId = buyer_id.toString()

  // fetch NFT
  let nft = null
  if (useSupabase) {
    const { data } = await supabase.from('nfts').select('*').eq('id', nft_id).limit(1).maybeSingle()
    nft = data
  } else {
    nft = mockDB.nfts.find(x => x.id === Number(nft_id))
  }
  if (!nft) return res.status(404).json({ ok: false, error: 'nft not found' })
  if (nft.owner_id) return res.status(400).json({ ok: false, error: 'already owned' })

  // get balance
  let balance = 0
  if (useSupabase) {
    const { data } = await supabase.from('balances').select('amount').eq('user_id', userId).limit(1).maybeSingle()
    balance = data ? Number(data.amount) : 0
  } else {
    balance = mockDB.balances[userId] || 0
  }

  if (balance < Number(nft.price)) {
    return res.json({ ok: false, error: 'insufficient_balance', balance })
  }

  // deduct and set owner
  const newBalance = (Number(balance) - Number(nft.price)).toFixed(8)
  if (useSupabase) {
    // transaction: update balances and nfts
    try {
      await supabase.from('balances').upsert({ user_id: userId, amount: newBalance }, { onConflict: ['user_id'] })
      await supabase.from('nfts').update({ owner_id: userId }).eq('id', nft_id)
      return res.json({ ok: true, balance: Number(newBalance) })
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) })
    }
  } else {
    mockDB.balances[userId] = Number(newBalance)
    const idx = mockDB.nfts.findIndex(x => x.id === Number(nft_id))
    if (idx !== -1) mockDB.nfts[idx].owner_id = userId
    return res.json({ ok: true, balance: Number(newBalance) })
  }
})

// ============= API: admin add balance ============
/**
 * body: { admin_id, target_id, amount }
 * only allowed if admin_id === ADMIN_TELEGRAM_ID
 */
app.post('/api/admin/add_balance', async (req, res) => {
  const { admin_id, target_id, amount } = req.body
  if (!admin_id || !target_id || typeof amount === 'undefined') return res.status(400).json({ ok: false, error: 'missing params' })
  if (String(admin_id) !== ADMIN_TELEGRAM_ID) return res.status(403).json({ ok: false, error: 'not authorized' })

  const tid = String(target_id)
  if (useSupabase) {
    try {
      // get current
      const { data } = await supabase.from('balances').select('amount').eq('user_id', tid).limit(1).maybeSingle()
      const cur = data ? Number(data.amount) : 0
      const updated = Number(cur) + Number(amount)
      await supabase.from('balances').upsert({ user_id: tid, amount: updated }, { onConflict: ['user_id'] })
      return res.json({ ok: true, balance: updated })
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) })
    }
  } else {
    const cur = mockDB.balances[tid] || 0
    mockDB.balances[tid] = Number(cur) + Number(amount)
    return res.json({ ok: true, balance: mockDB.balances[tid] })
  }
})

// ============= API: sync-nfts (placeholder/manual) ============
/**
 * For real integration you should run a worker that watches TON/Telegram for incoming NFT gifts,
 * then creates/updates rows in `nfts` or `gifts` table with:
 *   - name, number, sender_id, receiver_id, link, image_url
 *
 * This endpoint shows how to convert a simple payload into a t.me/nft link and (optionally)
 * fetch preview image (og:image) from that link, then store into DB.
 *
 * body: { name, number, sender_id, receiver_id }
 */
app.post('/api/sync-nfts', async (req, res) => {
  const { name, number, sender_id, receiver_id } = req.body
  if (!name || typeof number === 'undefined' || !sender_id || !receiver_id) {
    return res.status(400).json({ ok: false, error: 'missing params' })
  }

  const link = `https://t.me/nft/${encodeURIComponent(name)}-${encodeURIComponent(number)}`
  let image_url = null

  // Try to fetch OG image (best effort); many Telegram t.me pages include og:image meta
  try {
    const r = await fetch(link, { timeout: 5000 })
    if (r.ok) {
      const text = await r.text()
      const $ = cheerio.load(text)
      const og = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content')
      if (og) image_url = og
    }
  } catch (e) {
    // ignore fetch errors; we'll fallback to placeholder
    // console.warn('og fetch failed', e)
  }

  if (!image_url) image_url = '/assets/placeholder1.png'

  const newNft = {
    id: Date.now(), // simple id
    name,
    number,
    price: 1.0,
    link,
    image_url,
    owner_id: null,
    sender_id: String(sender_id),
    receiver_id: String(receiver_id),
    created_at: new Date().toISOString()
  }

  if (useSupabase) {
    try {
      await supabase.from('nfts').insert(newNft)
      return res.json({ ok: true, nft: newNft })
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) })
    }
  } else {
    mockDB.nfts.unshift(newNft)
    return res.json({ ok: true, nft: newNft })
  }
})

// ============= API: Ton purchase callback (optional) =============
/**
 * When TonConnect purchase is confirmed client can call backend to credit stars/premium:
 * body: { user_id, type: 'stars'|'premium', amount, tx_hash }
 * This endpoint is intentionally simple — in production verify tx_hash on-chain or via TON indexer.
 */
app.post('/api/ton/purchase', async (req, res) => {
  const { user_id, type, amount } = req.body
  if (!user_id || !type || typeof amount === 'undefined') return res.status(400).json({ ok: false, error: 'missing params' })

  if (type === 'stars') {
    // add stars to profile
    if (useSupabase) {
      try {
        const { data } = await supabase.from('profiles').select('stars_balance').eq('id', String(user_id)).limit(1).maybeSingle()
        const cur = data ? Number(data.stars_balance || 0) : 0
        const updated = cur + Number(amount)
        await supabase.from('profiles').update({ stars_balance: updated }).eq('id', String(user_id))
        return res.json({ ok: true, stars_balance: updated })
      } catch (e) { return res.status(500).json({ ok: false, error: String(e) }) }
    } else {
      const pid = String(user_id)
      mockDB.profiles[pid] = mockDB.profiles[pid] || { id: pid, stars_balance: 0 }
      mockDB.profiles[pid].stars_balance = (mockDB.profiles[pid].stars_balance || 0) + Number(amount)
      return res.json({ ok: true, stars_balance: mockDB.profiles[pid].stars_balance })
    }
  }

  if (type === 'premium') {
    // amount is months; set premium_until
    const months = Number(amount)
    const until = new Date()
    until.setMonth(until.getMonth() + months)
    if (useSupabase) {
      try {
        await supabase.from('profiles').update({ premium_until: until.toISOString() }).eq('id', String(user_id))
        return res.json({ ok: true, premium_until: until.toISOString() })
      } catch (e) { return res.status(500).json({ ok: false, error: String(e) }) }
    } else {
      const pid = String(user_id)
      mockDB.profiles[pid] = mockDB.profiles[pid] || {}
      mockDB.profiles[pid].premium_until = until.toISOString()
      return res.json({ ok: true, premium_until: until.toISOString() })
    }
  }

  return res.status(400).json({ ok: false, error: 'unknown type' })
})

// ============= Start server =============
app.listen(PORT, () => {
  console.log(`MarketHub server running on port ${PORT}`)
  console.log(`Admin Telegram ID: ${ADMIN_TELEGRAM_ID}`)
})
