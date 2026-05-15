/**
 * Analyze broker charge columns vs app charge logic.
 * Ignores user-only "actualbrokerage" column.
 */
const fs = require('fs');
const path = require('path');

const configCode = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
const CONFIG_MATCH = configCode.match(/const CONFIG = (\{[\s\S]*?\});/);
let CONFIG = {};
if (CONFIG_MATCH) eval('CONFIG = ' + CONFIG_MATCH[1]);

const tsvPath = path.join(__dirname, 'trades_256.tsv');
if (!fs.existsSync(tsvPath)) {
  console.error('Missing', tsvPath);
  process.exit(1);
}

const lines = fs.readFileSync(tsvPath, 'utf8').trim().split(/\r?\n/);
const header = lines[0].split('\t').map((h) => h.trim());
const idx = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());

const col = {
  side: idx('Buy/Sell'),
  qty: idx('Quantity'),
  price: idx('Rate'),
  bps: idx('Brokerage Per Share'),
  netRate: idx('Net Rate'),
  td: idx('TDInd'),
  sgst: idx('SGST'),
  cgst: idx('CGST'),
  igst: idx('IGST'),
  utgst: idx('UTGST'),
  cess: idx('Cess'),
  stamp: idx('Stamp'),
  to: idx('TO Charges'),
  ipft: idx('IPFT'),
  sebi: idx('Sebi Fees'),
  stt: idx('STT Amount'),
};

function num(s) {
  return parseFloat(String(s).replace(/,/g, '')) || 0;
}

function brokerCharges(row) {
  const qty = num(row[col.qty]);
  const brokerage = num(row[col.bps]) * qty;
  return (
    brokerage +
    num(row[col.sgst]) +
    num(row[col.cgst]) +
    num(row[col.igst]) +
    num(row[col.utgst]) +
    num(row[col.cess]) +
    num(row[col.stamp]) +
    num(row[col.to]) +
    num(row[col.ipft]) +
    num(row[col.sebi]) +
    num(row[col.stt])
  );
}

function ledgerExpensesPerShare(row) {
  const side = row[col.side].trim().toUpperCase();
  const price = num(row[col.price]);
  const net = num(row[col.netRate]);
  if (side.startsWith('B')) return Math.max(0, net - price);
  return Math.max(0, price - net);
}

function appBuyChargesCurrent(qty, price, expensesPerShare) {
  let brokerageAmount = 0;
  if (expensesPerShare > 0.01) {
    brokerageAmount = expensesPerShare * qty;
  } else {
    brokerageAmount = qty * price * CONFIG.brokerage;
  }
  const turnover = qty * price;
  const stt = turnover * 0.001;
  const txn = turnover * CONFIG.txnCharge;
  const sebi = turnover * CONFIG.sebiCharge;
  const stamp = turnover * CONFIG.stampDuty;
  const gst = (brokerageAmount + txn + sebi) * CONFIG.gst;
  return brokerageAmount + stt + txn + sebi + stamp + gst;
}

function appBuyChargesFixed(qty, price, expensesPerShare) {
  if (expensesPerShare > 0.01) return expensesPerShare * qty;
  return appBuyChargesCurrent(qty, price, 0);
}

function appSellCharges(qty, price, expensesPerShare) {
  if (expensesPerShare > 0.01) return expensesPerShare * qty;
  const turnover = qty * price;
  const brokerage = turnover * CONFIG.brokerage;
  const stt = turnover * CONFIG.sttSell;
  const txn = turnover * CONFIG.txnCharge;
  const sebi = turnover * CONFIG.sebiCharge;
  const gst = (brokerage + txn + sebi) * CONFIG.gst;
  return brokerage + stt + txn + sebi + gst;
}

function appIntradayEstimate(qty, price, side) {
  const turnover = qty * price;
  const brokerage = turnover * (side === 'BUY' ? CONFIG.brokerageIntraday : CONFIG.brokerageIntraday);
  const stt = side === 'SELL' ? turnover * CONFIG.sttIntraday : 0;
  const txn = turnover * CONFIG.txnCharge;
  const sebi = turnover * CONFIG.sebiCharge;
  const stamp = side === 'BUY' ? turnover * 0.00003 : 0;
  const gst = (brokerage + txn + sebi) * CONFIG.gst;
  return brokerage + stt + txn + sebi + stamp + gst;
}

let broker = {
  brokerage: 0,
  sgst: 0,
  cgst: 0,
  stamp: 0,
  to: 0,
  ipft: 0,
  sebi: 0,
  stt: 0,
  total: 0,
};
let ledgerOnly = 0;
let appCurrent = 0;
let appFixed = 0;
let n = 0;
let buyDoubleExtra = 0;

for (let i = 1; i < lines.length; i++) {
  const row = lines[i].split('\t');
  if (row.length < 10) continue;
  n++;
  const qty = num(row[col.qty]);
  const price = num(row[col.price]);
  const side = row[col.side].trim().toUpperCase().startsWith('B') ? 'BUY' : 'SELL';
  const isIntraday = row[col.td].trim().toUpperCase() === 'T';
  const exp = ledgerExpensesPerShare(row);

  const b = num(row[col.bps]) * qty;
  broker.brokerage += b;
  broker.sgst += num(row[col.sgst]);
  broker.cgst += num(row[col.cgst]);
  broker.stamp += num(row[col.stamp]);
  broker.to += num(row[col.to]);
  broker.ipft += num(row[col.ipft]);
  broker.sebi += num(row[col.sebi]);
  broker.stt += num(row[col.stt]);
  broker.total += brokerCharges(row);

  ledgerOnly += exp * qty;

  let cur, fix;
  if (isIntraday) {
    if (exp > 0.01) {
      cur = exp * qty;
      fix = cur;
    } else {
      cur = appIntradayEstimate(qty, price, side);
      fix = cur;
    }
  } else if (side === 'BUY') {
    cur = appBuyChargesCurrent(qty, price, exp);
    fix = appBuyChargesFixed(qty, price, exp);
    buyDoubleExtra += cur - fix;
  } else {
    cur = appSellCharges(qty, price, exp);
    fix = cur;
  }
  appCurrent += cur;
  appFixed += fix;
}

console.log('Trade rows:', n);
console.log('\n--- Broker columns (your report) ---');
console.log('Brokerage (BPS × Qty):', broker.brokerage.toFixed(2));
console.log('SGST:', broker.sgst.toFixed(2));
console.log('CGST:', broker.cgst.toFixed(2));
console.log('Stamp:', broker.stamp.toFixed(2));
console.log('TO Charges:', broker.to.toFixed(2));
console.log('IPFT:', broker.ipft.toFixed(2));
console.log('Sebi Fees:', broker.sebi.toFixed(2));
console.log('STT:', broker.stt.toFixed(2));
console.log('TOTAL:', broker.total.toFixed(2));
console.log('  (your earlier rollup ~167576)');

console.log('\n--- Ledger net-rate expenses (buy: net−price, sell: price−net) ---');
console.log('Sum per-leg expenses:', ledgerOnly.toFixed(2));

console.log('\n--- App simulation (sum each trade leg, not FIFO) ---');
console.log('Current buy logic (double-stack on buys):', appCurrent.toFixed(2));
console.log('Fixed buy logic (expenses only when net rate):', appFixed.toFixed(2));
console.log('Extra from buy bug alone:', buyDoubleExtra.toFixed(2));
console.log('Ratio current/broker:', (appCurrent / broker.total).toFixed(3));
console.log('Ratio fixed/broker:', (appFixed / broker.total).toFixed(3));
