'use strict'

const Discord = require('discord.js')
const { Network, TransactionType, Transaction, Key } = require('semux-js')
const Long = require('long')
const rp = require('request-promise')
const botSettings = require('./config/config-bot.json')
const allowedCommands = require('./config/allowed-commands.json')
const { getPrice, getPriceInSats, getCommits, getAllStats } = require('./utils.js')
const { scanNewBlock } = require('./alerts.js')
const { Users, sequelize } = require('./models')

const prefix = botSettings.prefix
const bot = new Discord.Client({ disableEveryone: true })

const API = 'https://api.semux.online/v2.1.0/'
const FEE = 5000000

bot.on('ready', () => {
  console.log('Bot is connected.')
})

async function getAddress (address) {
  return JSON.parse(await rp(API + 'account?address=' + address))
}

async function sendToApi (tx) {
  const serialize = Buffer.from(tx.toBytes().buffer).toString('hex')
  try {
    var { result } = await rp({
      method: 'POST',
      uri: `${API}transaction/raw?raw=${serialize}&validateNonce=true`,
      json: true
    })
  } catch (e) {
    console.log(e)
  }
  if (result) {
    return result
  }
}

async function sendCoins (authorId, toAddress, value, msg, comment) {
  let hexString = '0x746970' // default "tip"
  if (comment) {
    let bytesArray = Buffer.from(comment)
    hexString = '0x' + toHexString(bytesArray)
  }
  if (!toAddress || !value) {
    return {
      error: true,
      reason: 'Amount of SEM and Discord Username are required.'
    }
  }
  const from = await Users.findOne({ where: { discord_id: authorId } })
  if (!from) {
    return {
      error: true,
      reason: "You don't have account yet, type /getAddress first."
    }
  }
  var isFrom = await getAddress(from.address)
  try {
    await getAddress(toAddress)
  } catch (e) {
    return { error: true, reason: 'Wrong recipient, try another one.' }
  }
  if (value.includes(',')) value = value.replace(/,/g, '.')
  let amount = parseFloat(value)
  if (!amount) return { error: true, reason: 'Amount is not correct.' }
  amount = amount * Math.pow(10, 9)
  if (amount < 0.000000001) return { error: true, reason: 'Wrong amount, try another one.' }
  // check reciever balance before transfer
  const fromAddressBal = await getAddress(from.address)
  let nonce = parseInt(isFrom.result.nonce, 10) + parseInt(isFrom.result.pendingTransactionCount, 10)
  const available = parseFloat(fromAddressBal.result.available)
  if (available === amount) {
    amount = amount - FEE
  }
  if (available < (amount + FEE)) {
    return { error: true, reason: `Insufficient balance, you have **${parseBal(available)} SEM**` }
  }
  const privateKey = Key.importEncodedPrivateKey(hexBytes(from.private_key))
  try {
    var tx = new Transaction(
      Network.MAINNET,
      TransactionType.TRANSFER,
      hexBytes(toAddress), // to
      Long.fromNumber(amount), // value
      Long.fromNumber(FEE), // fee
      Long.fromNumber(nonce), // nonce
      Long.fromNumber(new Date().getTime()), // timestamp
      hexBytes(hexString) // data
    ).sign(privateKey)
  } catch (e) {
    console.log(e)
  }
  let hash = await sendToApi(tx)

  if (!hash) {
    return { error: true, reason: 'Error while tried to create transaction.' }
  } else {
    return { error: false, hash }
  }
}

async function changeStats (senderId, recieverId, value) {
  if (value.includes(',')) value = value.replace(/,/g, '.')
  let amount = parseFloat(value)
  let sender = await Users.findOne({ where: { discord_id: senderId } })
  let reciever = await Users.findOne({ where: { discord_id: recieverId } })
  await sender.update({
    sent: sender.sent + amount
  })
  await reciever.update({
    received: reciever.received + amount
  })
}

bot.on('message', async msg => {
  // replace double whitespaces with a single one
  msg.content = msg.content.toString().replace(/  +/g, ' ')
  const args = msg.content.trim().split(' ')
  const authorId = msg.author.id

  if (allowedCommands[args[0]]) {
    console.log(`[${new Date()}] ${msg.author.username}#${msg.author.discriminator}: ${msg.content}`)
  }

  if (msg.content.toLowerCase() === `${prefix}topdonators`) {
    let donatorsList = await Users.findAll({
      where: { 'sent': { [sequelize.Sequelize.Op.ne]: null } },
      order: [['sent', 'DESC']],
      limit: 10
    })
    let string = 'Top-10 donators:\n'
    let i = 1
    for (let row of donatorsList) {
      string += `${i++}) ${row.username} **${row.sent.toFixed(3)}** SEM\n`
    }
    return msg.channel.send(string)
  }

  if (msg.content.toLowerCase() === `${prefix}toprecipients`) {
    let recievesList = await Users.findAll({
      where: { 'received': { [sequelize.Sequelize.Op.ne]: null } },
      order: [['received', 'DESC']],
      limit: 10
    })
    let string = 'Top-10 recipients:\n'
    let i = 1
    for (let row of recievesList) {
      string += `${i++}) ${row.username} **${row.received.toFixed(3)}** SEM\n`
    }
    return msg.channel.send(string)
  }

  // tip to username
  if (msg.content.startsWith(`${prefix}tip `)) {
    let comment = ''
    const amount = args[2]
    const username = args[1]
    if (args[3] && args[3].includes("'")) {
      try {
        comment = msg.content.trim().match(/'([^']+)'/)[1]
      } catch (e) {
        return msg.reply('Close quotes please')
      }
    }

    let usernameId = username
    if (username.includes('@')) {
      usernameId = username.substring(2, username.length - 1)
      usernameId = usernameId.replace('!', '')
    }
    console.log(`Tipping to ${usernameId}`)
    let userAddress = await Users.findOne({ where: { discord_id: usernameId } })
    if (!userAddress) {
      const newUserName = bot.users.find(user => user.id === usernameId)
      if (!newUserName) {
        console.log('Cannot find this user on the server. Aborting.')
        return msg.reply('Cannot find this user on the server.')
      }
      console.log('Recipient doesn\'t have public address yet. Generating new key pair.')
      const key = Key.generateKeyPair()
      const privateKey = toHexString(key.getEncodedPrivateKey())
      const address = '0x' + key.toAddressHexString()
      var newRegister = await Users.create({
        username: newUserName.username,
        discord_id: usernameId,
        address: address,
        private_key: privateKey
      })
      userAddress = newRegister.address
    } else {
      userAddress = userAddress.address
    }
    let reciever = bot.users.find(user => user.id === usernameId)
    if (!reciever) return msg.reply('Cannot find this user on the server.')
    try {
      var trySend = await sendCoins(authorId, userAddress, amount, msg, comment)
    } catch (e) {
      // console.log(e)
    }
    if (trySend.error) return msg.reply(trySend.reason)
    await changeStats(authorId, usernameId, amount)
    try {
      await reciever.send(`You've received tips. TX: <https://semux.info/explorer/transaction/${trySend.hash}> \nSend me: \`/balance\` or \`/help\` to find more details`)
    } catch (e) {
      console.error(e)
    }
    await msg.reply(`Tip sent. TX: <https://semux.info/explorer/transaction/${trySend.hash}>`)
  }

  // get donate address
  if (msg.content.toLowerCase().startsWith(`${prefix}getaddress`) || msg.content.toLowerCase().startsWith(`${prefix}address`)) {
    const user = await Users.findOne({ where: { discord_id: authorId } })
    if (!user) {
      const key = Key.generateKeyPair()
      const privateKey = toHexString(key.getEncodedPrivateKey())
      const address = '0x' + key.toAddressHexString()
      if (address) {
        let text = `This is your unique deposit address: **${address}**\n
        You can deposit some SEM to this address and use your coins for tipping.\n
        People will be tipping to this address too. Try to be helpful to the community ;)
        `
        try {
          await msg.author.send(text)
        } catch (e) {
          console.error(e)
          msg.channel.send(text)
        }
        await Users.create({
          username: msg.author.username,
          discord_id: authorId,
          address: address,
          private_key: privateKey
        })
      }
    } else {
      let text = `Your deposit address is: **${user.address}**`
      try {
        await msg.author.send(text)
      } catch (e) {
        console.error(e)
        msg.channel.send(text)
      }
    }
  }

  // withdraw
  if (msg.content.startsWith(`${prefix}withdraw`)) {
    const amount = args[2]
    const toAddress = args[1]
    let trySend
    try {
      trySend = await sendCoins(authorId, toAddress, amount, msg)
    } catch (e) {
      // console.log(e)
    }
    let responseToWithdrawal = 'Your withdrawal request has been processed successfully.'
    if (trySend.error) {
      responseToWithdrawal = trySend.reason
    }
    try {
      await msg.author.send(responseToWithdrawal)
    } catch (e) {
      console.error(e)
    }
  }

  // balance
  if (msg.content.startsWith(`${prefix}balance`) || msg.content.startsWith(`${prefix}bal`)) {
    const price = getPrice()
    const user = await Users.findOne({ where: { discord_id: authorId } })
    if (!user) return msg.reply("Sorry, but you don't have account, type **/getAddress** first.")
    const userBal = JSON.parse(await rp(API + 'account?address=' + user.address))
    if (userBal.success) {
      const availabeBal = numberFormat(parseBal(userBal.result.available))
      // const lockedBal = numberFormat(parseBal(userBal.result.locked))
      const totalBal = parseBal(userBal.result.available) + parseBal(userBal.result.locked)
      let usdBalance = price * totalBal
      usdBalance = numberFormat(usdBalance)
      if (totalBal === 0) {
        msg.channel.send(`Your wallet is empty: **${availabeBal}** SEM`)
      } else {
        msg.channel.send(`Your balance is: **${availabeBal}** SEM (*${usdBalance} USD*)`)
      }
    } else {
      return msg.channel.send('Semux api issues')
    }
  }

  if (msg.content === `${prefix}stats`) {
    const price = getPrice()
    try {
      var { result } = JSON.parse(await rp(API + 'info'))
    } catch (e) {
      return msg.channel.send('Lost connection with API server')
    }
    if (result) {
      let stats = getAllStats()
      return msg.channel.send(
        `Semux Last Block: **${numberToString(result.latestBlockNumber)}**\n` +
        `Pending Txs: **${result.pendingTransactions}**\n` +
        `SEM price: **$${price} USD** (${getPriceInSats()} sats)\n` +
        `Marketcap: $${numberToString(stats.marketCap)} USD\n` +
        `Circulating supply: ${numberToString(stats.circulatingSupply)} SEM\n` +
        `Yearly ROI of validator: **${stats.validatorRoi}%**\n` +
        `Total transactions: **${numberToString(stats.totalTransactions)} Txs**\n` +
        `Total addresses: **${numberToString(stats.totalAddresses)}**\n` +
        `Blockchain size: **${stats.blockchainSize}**\n` +
        `Commits in last 4 weeks: **${getCommits()}**\n`
      )
    }
  }

  if (msg.content === `${prefix}help`) {
    msg.channel.send(`SemuxBot commands:\n` +
      `**${prefix}balance** - show your balance.\n` +
      `**${prefix}tip** *<@username>* *<amount>* *<'comment'>*- send SEM to a Discord user.\n` +
      `**${prefix}withdraw** *<address>* *<amount>* - withdraw SEM to your personal address.\n` +
      `**${prefix}getAddress** - get your personal deposit/tips address.\n` +
      `**${prefix}topDonators** - show the most active donators.\n` +
      `**${prefix}topRecipients** - show the luckiest recipients.\n` +
      `**${prefix}stats** - show current Semux network stats.`
    )
  }
})

setInterval(async function () {
  result = await scanNewBlock()
  if (result.error) {
    return
  }
  const channel = bot.channels.find(c => c.name === 'trading')
  for (let tx of result.transfers) {
    if (tx.type === 'deposited') {
      channel.send(`**[whale alert]** ${tx.value} SEM ${tx.type} to ${tx.exchange} :inbox_tray:`)
    } else {
      channel.send(`**[whale alert]** ${tx.value} SEM ${tx.type} from ${tx.exchange} :outbox_tray:`)
    }
  }
}, 5 * 1000)

function numberFormat (balance) {
  const balanceInt = new Intl.NumberFormat('us-US').format(balance)
  return balanceInt
}

function numberToString (number) {
  if (!number) {
    return ''
  }
  return number.toString().replace(/(\d)(?=(\d\d\d)+([^\d]|$))/g, '$1,')
}

function parseBal (balance) {
  return parseFloat((parseFloat(balance) / Math.pow(10, 9)).toFixed(10))
}

function hexBytes (s) {
  return Buffer.from(s.replace('0x', ''), 'hex')
}

function toHexString (byteArray) {
  return Array.from(byteArray, function (byte) {
    return ('0' + (byte & 0xFF).toString(16)).slice(-2)
  }).join('')
}

bot.login(botSettings.token)
