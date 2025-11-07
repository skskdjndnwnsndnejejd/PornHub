/**
 * script.js - client logic for MarketHub (static frontend)
 *
 * - Handles splash animation -> main UI
 * - Auth: sends Telegram WebApp initData to /api/auth/verify
 * - Loads /api/nfts and renders 2-up grid
 * - Buy button calls /api/nft/buy (uses internal balance)
 * - Premium&Stars buttons: placeholder for TonConnect integration
 * - Admin tab visible only to ADMIN_TELEGRAM_ID (returned in user.id)
 *
 * Notes:
 *  - This frontend expects to be opened inside Telegram MiniApp (window.Telegram.WebApp).
 *  - For local testing you can mock initData by calling `window.mockInitData = true`
 */

const ADMIN_TELEGRAM_ID = '6828395702'

const $ = (sel) => document.querySelector(sel)
const $all = (sel) => Array.from(document.querySelectorAll(sel))

const splash = $('#splash')
const main = $('#main')
const catalog = $('#catalog')
const balanceAmountEl = $('#balance-amount')
const toastEl = $('#toast')
const adminTab = $('#admin-tab')

let APP = {
  user: null,
  token: null,
  balance: 0,
  nfts: []
}

function showToast(text, timeout = 2500) {
  toastEl.textContent = text
  toastEl.classList.remove('hidden')
  setTimeout(()=> toastEl.classList.add('hidden'), timeout)
}

async function verifyTelegram() {
  // If inside Telegram, get initData from window.Telegram.WebApp.initData
  let initData = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData ? window.Telegram.WebApp.initData : null

  // For local dev: allow mock
  if (!initData && window.mockInitData) {
    // a minimal initData string that server can accept only if TELEGRAM_BOT_TOKEN isn't checked.
    initData = 'user=%7B%22id%22%3A12345678%2C%22first_name%22%3A%22Demo%22%7D&hash=fakehash'
  }

  if (!initData) {
    // still show UI but not authenticated
    showToast('Откройте приложение из Telegram чтобы авторизоваться.', 3000)
    renderMain()
    return
  }

  try {
    const r = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData })
    })
    const j = await r.json()
    if (j.ok) {
      APP.user = j.user
      APP.token = j.token
      // show admin tab if matches
      if (APP.user && String(APP.user.id) === ADMIN_TELEGRAM_ID) {
        adminTab.style.display = 'inline-block'
      }
      // fetch initial balance (server-side or mock)
      await refreshBalance()
      await loadNFTs()
    } else {
      showToast('Auth failed: ' + (j.error || 'unknown'))
      await loadNFTs() // still load nfts
    }
  } catch (e) {
    console.error(e)
    showToast('Ошибка сети при авторизации')
    await loadNFTs()
  }
}

async function refreshBalance() {
  // For demo: balance is in /api/nfts? we will infer from a simple call:
  // Ideally we have an endpoint /api/balance; here we fetch nfts and read mock balances if available
  // We'll call /api/nfts just to trigger server; balance in mock is stored client-side via /api/admin/add_balance previously.
  try {
    // attempt to infer balance by calling /api/nfts (server doesn't return balance)
    // Instead we'll show placeholder for now and rely on server responses to update
    // Try to fetch a specific endpoint /api/balance (not implemented); fallback to stored APP.balance
    balanceAmountEl.textContent = (APP.balance !== null) ? (APP.balance + ' TON') : '--'
  } catch (e) {
    balanceAmountEl.textContent = '--'
  }
}

function renderNFTCard(nft) {
  const div = document.createElement('div')
  div.className = 'card'
  div.innerHTML = `
    <div class="img-wrap"><img src="${nft.image_url || '/assets/placeholder1.png'}" alt="${nft.name}"></div>
    <h4>${escapeHtml(nft.name)} #${escapeHtml(String(nft.number))}</h4>
    <div class="price-row"><div>${nft.price} </div><div style="opacity:0.7">TON</div></div>
    <button class="buy-btn" data-id="${nft.id}">${nft.owner_id ? 'Owned' : 'Купить'}</button>
  `
  const btn = div.querySelector('.buy-btn')
  if (nft.owner_id) btn.disabled = true
  btn.addEventListener('click', async (e) => {
    if (!APP.user) return showToast('Авторизуйтесь в Telegram внутри WebApp.')
    if (nft.owner_id) return showToast('Лот уже куплен')
    // BUY via internal balance
    try {
      const r = await fetch('/api/nft/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buyer_id: APP.user.id, nft_id: nft.id })
      })
      const j = await r.json()
      if (j.ok) {
        showToast('Покупка успешна')
        APP.balance = j.balance
        balanceAmountEl.textContent = APP.balance + ' TON'
        // reload nfts
        await loadNFTs()
      } else {
        if (j.error === 'insufficient_balance') {
          showToast('Недостаточно средств. Обратитесь к администратору.')
        } else {
          showToast('Ошибка покупки: ' + (j.error || 'unknown'))
        }
      }
    } catch (err) {
      console.error(err)
      showToast('Сетевая ошибка при покупке')
    }
  })
  return div
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (m)=> ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])) }

async function loadNFTs() {
  catalog.innerHTML = ''
  try {
    const r = await fetch('/api/nfts')
    const j = await r.json()
    if (!j.ok) { showToast('Не удалось загрузить NFT'); return }
    APP.nfts = j.nfts || []
    APP.nfts.forEach(nft => {
      const el = renderNFTCard(nft)
      catalog.appendChild(el)
    })
  } catch (e) {
    console.error(e)
    showToast('Ошибка загрузки каталога')
  }
}

// splash -> main
function showMain() {
  splash.classList.add('hidden')
  main.classList.remove('hidden')
}

// tabs
$all('.tab').forEach(btn=>{
  btn.addEventListener('click', async (e)=>{
    $all('.tab').forEach(t=>t.classList.remove('active'))
    btn.classList.add('active')
    const tab = btn.dataset.tab
    if (tab === 'catalog') { await loadNFTs() }
    if (tab === 'gifts') { showToast('My Gifts пока в разработке') }
    if (tab === 'premium') { showPremium() }
    if (tab === 'admin') { showAdmin() }
  })
})

function showPremium() {
  // Placeholder UI for premium & stars. Here you'd integrate TonConnect.
  const html = `
    <div style="padding:16px">
      <h3>Premium & Stars</h3>
      <p>Stars: 1 шт = 0.01 TON</p>
      <div style="display:flex; gap:8px; margin-top:8px">
        <button class="btn" id="buy-stars">Купить звезды</button>
        <button class="btn" id="buy-prem-3">Premium 3м (4 TON)</button>
      </div>
      <p style="opacity:0.7; font-size:13px; margin-top:10px">Платежи через TonConnect</p>
    </div>
  `
  catalog.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.innerHTML = html
  catalog.appendChild(wrap)

  // attach handlers
  $('#buy-stars')?.addEventListener('click', ()=> showToast('TonConnect: открытие покупки звёзд (заглушка)'))
  $('#buy-prem-3')?.addEventListener('click', ()=> showToast('TonConnect: покупка Premium 3м (заглушка)'))
}

function showAdmin() {
  // only visible for admin via tab visibility; still protect actions server-side
  const html = `
    <div style="padding:16px">
      <h3>Admin Panel</h3>
      <div style="display:flex; gap:8px; margin-top:8px; flex-direction:column">
        <input id="admin-user" placeholder="Telegram ID (target)" />
        <input id="admin-amount" placeholder="Amount (TON)" />
        <button id="admin-issue">Выдать баланс</button>
      </div>
    </div>
  `
  catalog.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.innerHTML = html
  catalog.appendChild(wrap)

  $('#admin-issue')?.addEventListener('click', async ()=>{
    const target = $('#admin-user').value.trim()
    const amount = Number($('#admin-amount').value)
    if (!target || !amount) return showToast('Заполните поля')
    try {
      const r = await fetch('/api/admin/add_balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_id: APP.user.id, target_id: target, amount })
      })
      const j = await r.json()
      if (j.ok) {
        showToast('Баланс выдан: ' + j.balance + ' TON')
      } else {
        showToast('Ошибка: ' + (j.error || 'unknown'))
      }
    } catch (e) {
      console.error(e)
      showToast('Сетевой сбой')
    }
  })
}

// init
async function init() {
  // splash for ~2 seconds with animation then show main
  setTimeout(()=> {
    showMain()
  }, 1800)

  // verify user (calls server) — this will set APP.user and optionally show admin
  await verifyTelegram()

  // attach refresh button
  $('#btn-refresh')?.addEventListener('click', async ()=> {
    await refreshBalance()
    await loadNFTs()
    showToast('Обновлено')
  })
}

init()
