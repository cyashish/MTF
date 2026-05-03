const fs = require('fs');

// Load config.js
const configCode = fs.readFileSync('config.js', 'utf8');
const CONFIG_MATCH = configCode.match(/const CONFIG = (\{[\s\S]*?\});/);
let CONFIG = {};
if (CONFIG_MATCH) {
    eval('CONFIG = ' + CONFIG_MATCH[1]);
}

const csv = fs.readFileSync('test_pnl.csv', 'utf8').trim().split('\n');
const headers = csv[0].split(',');
const rows = csv.slice(1).map(line => {
    const parts = line.split(',');
    if (parts.length < 10) return null;
    return {
        scrip: parts[0],
        qty: parseFloat(parts[1]),
        buyDate: parts[2],
        buyRate: parseFloat(parts[3]),
        buyValue: parseFloat(parts[4]),
        sellDate: parts[5],
        sellRate: parseFloat(parts[6]),
        sellValue: parseFloat(parts[7]),
        days: parseInt(parts[8]),
        realisedPnl: parseFloat(parts[9])
    };
}).filter(Boolean);

function estimateBuyCharges(qty, price) {
    const turnover = qty * price;
    const brokerage = turnover * CONFIG.brokerage;
    const stt = turnover * 0.001;
    const txn = turnover * CONFIG.txnCharge;
    const sebi = turnover * CONFIG.sebiCharge;
    const stamp = turnover * CONFIG.stampDuty;
    const gst = (brokerage + txn + sebi) * CONFIG.gst;
    return brokerage + stt + txn + sebi + stamp + gst;
}

function estimateSellCharges(qty, price) {
    const turnover = qty * price;
    const brokerage = turnover * CONFIG.brokerage;
    const stt = turnover * CONFIG.sttSell;
    const txn = turnover * CONFIG.txnCharge;
    const sebi = turnover * CONFIG.sebiCharge;
    const gst = (brokerage + txn + sebi) * CONFIG.gst;
    return brokerage + stt + txn + sebi + gst;
}

function estimateIntradayBuyCharges(qty, price) {
    const turnover = qty * price;
    const brokerage = turnover * CONFIG.brokerageIntraday;
    const stt = 0;
    const txn = turnover * CONFIG.txnCharge;
    const sebi = turnover * CONFIG.sebiCharge;
    const stamp = turnover * 0.00003;
    const gst = (brokerage + txn + sebi) * CONFIG.gst;
    return brokerage + stt + txn + sebi + stamp + gst;
}

function estimateIntradaySellCharges(qty, price) {
    const turnover = qty * price;
    const brokerage = turnover * CONFIG.brokerageIntraday;
    const stt = turnover * CONFIG.sttIntraday;
    const txn = turnover * CONFIG.txnCharge;
    const sebi = turnover * CONFIG.sebiCharge;
    const stamp = 0;
    const gst = (brokerage + txn + sebi) * CONFIG.gst;
    return brokerage + stt + txn + sebi + stamp + gst;
}

let totalBrokerPnl = 0;
let totalOurGrossPnl = 0;
let totalOurNetPnlWithoutInterest = 0;
let totalOurInterest = 0;

console.log("Scrip,Days,Gross(S-B),BrokerPnl,OurPnl,Diff(Broker-Our),OurInterest");

rows.forEach(r => {
    const isIntraday = r.days === 0;
    
    let buyCharges = 0;
    let sellCharges = 0;
    
    if (isIntraday) {
        buyCharges = estimateIntradayBuyCharges(r.qty, r.buyRate);
        sellCharges = estimateIntradaySellCharges(r.qty, r.sellRate);
    } else {
        buyCharges = estimateBuyCharges(r.qty, r.buyRate);
        sellCharges = estimateSellCharges(r.qty, r.sellRate);
    }
    
    const grossPnl = r.sellValue - r.buyValue;
    const ourNetPnlWithoutInterest = grossPnl - buyCharges - sellCharges;
    
    // Interest is qty * buyRate * fundedRatio * rate/365 * days
    const fundedRatio = 1.0;
    const interest = isIntraday ? 0 : (r.buyValue + buyCharges) * fundedRatio * (CONFIG.mtfInterestRate / 365) * r.days;
    
    totalBrokerPnl += r.realisedPnl;
    totalOurGrossPnl += grossPnl;
    totalOurNetPnlWithoutInterest += ourNetPnlWithoutInterest;
    totalOurInterest += interest;
    
    const diff = r.realisedPnl - ourNetPnlWithoutInterest;
    
    // Print lines with significant difference
    if (Math.abs(diff) > 100) {
        // console.log(`${r.scrip},${r.days},${grossPnl.toFixed(2)},${r.realisedPnl.toFixed(2)},${ourNetPnlWithoutInterest.toFixed(2)},${diff.toFixed(2)},${interest.toFixed(2)}`);
    }
});

console.log("--- Summary ---");
console.log("Total Broker Realised P&L (Taxes incl, no Interest):", totalBrokerPnl.toFixed(2));
console.log("Total Our Gross P&L (Sell - Buy):", totalOurGrossPnl.toFixed(2));
console.log("Total Our Net P&L (Taxes incl, no Interest):", totalOurNetPnlWithoutInterest.toFixed(2));
console.log("Difference in P&L without Interest:", (totalBrokerPnl - totalOurNetPnlWithoutInterest).toFixed(2));
console.log("Total Our Estimated Interest:", totalOurInterest.toFixed(2));
console.log("Our Net P&L WITH Interest:", (totalOurNetPnlWithoutInterest - totalOurInterest).toFixed(2));

