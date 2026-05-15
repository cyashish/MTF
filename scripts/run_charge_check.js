/**
 * Quick charge reconciliation (Node). Paste contract-note TSV to scripts/trades_256.tsv
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const ctx = { console, CONFIG: null, window: {} };
vm.createContext(ctx);

const configSrc = fs
  .readFileSync(path.join(root, 'config.js'), 'utf8')
  .replace(/window\.APP_STATE[\s\S]*?};\s*/m, '')
  .replace('const CONFIG', 'var CONFIG');
vm.runInThisContext(configSrc, ctx);
vm.runInThisContext(fs.readFileSync(path.join(root, 'dataHandler.js'), 'utf8'), ctx);
vm.runInThisContext(fs.readFileSync(path.join(root, 'calculator.js'), 'utf8'), ctx);

function brokerRowTotal(cols, header) {
  const idx = (n) => header.findIndex((h) => h.toLowerCase() === n.toLowerCase());
  const num = (s) => parseFloat(String(s).replace(/,/g, '')) || 0;
  const qty = num(cols[idx('Quantity')]);
  const bps = num(cols[idx('Brokerage Per Share')]);
  return (
    bps * qty +
    num(cols[idx('SGST')]) +
    num(cols[idx('CGST')]) +
    num(cols[idx('IGST')]) +
    num(cols[idx('UTGST')]) +
    num(cols[idx('Cess')]) +
    num(cols[idx('Stamp')]) +
    num(cols[idx('TO Charges')]) +
    num(cols[idx('IPFT')]) +
    num(cols[idx('Sebi Fees')]) +
    num(cols[idx('STT Amount')])
  );
}

function sumBrokerFile(tsv) {
  const lines = tsv.trim().split(/\r?\n/);
  const header = lines[0].split('\t').map((h) => h.trim());
  let total = 0;
  let n = 0;
  const parts = { brokerage: 0, sgst: 0, cgst: 0, stamp: 0, to: 0, ipft: 0, sebi: 0, stt: 0 };
  const idx = (n) => header.findIndex((h) => h.toLowerCase() === n.toLowerCase());
  const num = (s) => parseFloat(String(s).replace(/,/g, '')) || 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 8) continue;
    n++;
    const qty = num(cols[idx('Quantity')]);
    parts.brokerage += num(cols[idx('Brokerage Per Share')]) * qty;
    parts.sgst += num(cols[idx('SGST')]);
    parts.cgst += num(cols[idx('CGST')]);
    parts.stamp += num(cols[idx('Stamp')]);
    parts.to += num(cols[idx('TO Charges')]);
    parts.ipft += num(cols[idx('IPFT')]);
    parts.sebi += num(cols[idx('Sebi Fees')]);
    parts.stt += num(cols[idx('STT Amount')]);
    total += brokerRowTotal(cols, header);
  }
  return { n, total, parts };
}

function sumAppCharges(tsv) {
  const trades = DataHandler.parseContractNoteTSV(tsv.trim());
  const { closedPositions } = Calculator.processTrades(trades, {});
  const total = closedPositions.reduce((s, p) => s + (p.totalCharges || 0), 0);
  return { trades: trades.length, total };
}

// Spot-check first trade from user paste
const sampleBuy = {
  qty: 250,
  price: 1363.4,
  bps: 5.45,
};
const sampleSell = { qty: 250, price: 1389, bps: 5.56 };
const buyCharges = Calculator.estimateDeliveryCharges(
  sampleBuy.qty,
  sampleBuy.price,
  sampleBuy.bps * sampleBuy.qty,
  'BUY'
);
const sellCharges = Calculator.estimateDeliveryCharges(
  sampleSell.qty,
  sampleSell.price,
  sampleSell.bps * sampleSell.qty,
  'SELL'
);

console.log('--- Spot check ICICIBANK (broker row 1 buy / sell) ---');
console.log('Buy charges (app):', buyCharges.toFixed(2), '(broker ~2012.48)');
console.log('Sell charges (app):', sellCharges.toFixed(2), '(broker ~1999.85)');

const tsvPath = path.join(__dirname, 'trades_256.tsv');
if (fs.existsSync(tsvPath)) {
  const tsv = fs.readFileSync(tsvPath, 'utf8');
  const broker = sumBrokerFile(tsv);
  const app = sumAppCharges(tsv);
  console.log('\n--- Full file:', tsvPath, '---');
  console.log('Rows:', broker.n, '| Broker total:', broker.total.toFixed(2));
  console.log('  brokerage', broker.parts.brokerage.toFixed(2));
  console.log('  sgst', broker.parts.sgst.toFixed(2), 'cgst', broker.parts.cgst.toFixed(2));
  console.log('  stamp', broker.parts.stamp.toFixed(2), 'to', broker.parts.to.toFixed(2));
  console.log('  ipft', broker.parts.ipft.toFixed(2), 'sebi', broker.parts.sebi.toFixed(2));
  console.log('  stt', broker.parts.stt.toFixed(2));
  console.log('Parsed trades:', app.trades, '| App closed charges:', app.total.toFixed(2));
  console.log('Ratio app/broker:', (app.total / broker.total).toFixed(3));
} else {
  console.log('\nSave your TSV as scripts/trades_256.tsv and re-run for full totals.');
}
