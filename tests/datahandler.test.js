'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadApp, run, json, jsonAsync } = require('./helpers');

let ctx;
function getCtx() {
    if (!ctx) ctx = loadApp();
    return ctx;
}

function closeTo(actual, expected, eps = 0.001) {
    assert.ok(
        Math.abs(actual - expected) <= eps,
        `expected ${actual} to be within ${eps} of ${expected}`
    );
}

async function parseInput(text) {
    return jsonAsync(getCtx(), `DataHandler.parseInput(${JSON.stringify(text)})`);
}

function normalizeRealmValue(value) {
    // Values returned from the vm sandbox belong to another realm; JSON round-trip
    // makes them plain host objects so deepStrictEqual compares them structurally.
    return JSON.parse(JSON.stringify(value));
}

async function fetchPrice(symbol, opts, fetchImpl) {
    const c = getCtx();
    c.fetch = fetchImpl;
    try {
        return normalizeRealmValue(await run(c, `DataHandler.fetchPrice(${JSON.stringify(symbol)}, ${JSON.stringify(opts || {})})`));
    } finally {
        delete c.fetch;
    }
}

function okFetch(contents) {
    return async () => ({
        ok: true,
        json: async () => ({ contents: JSON.stringify(contents) })
    });
}

// ---------------------------------------------------------------- parseInput routing

test('parseInput returns [] for empty or whitespace input', async () => {
    assert.deepEqual(await parseInput(''), []);
    assert.deepEqual(await parseInput('   \n\t  '), []);
});

test('isContractNoteExport detects the broker header only', () => {
    const c = getCtx();
    assert.equal(run(c, 'DataHandler.isContractNoteExport("Trade Date\tScrip Symbol\tTDInd\tBuy/Sell\tQuantity\tRate\tBrokerage Per Share\tNet Rate")'), true);
    assert.equal(run(c, 'DataHandler.isContractNoteExport("Date,Symbol,Qty,Price,Side")'), false);
});

// ---------------------------------------------------------------- contract-note TSV

const CONTRACT_HEADER = 'Trade Date\tScrip Symbol\tTDInd\tBuy/Sell\tQuantity\tRate\tBrokerage Per Share\tNet Rate';

test('parseContractNoteTSV parses buy/sell rows, skips Exchange totals and invalid rows', async () => {
    const tsv = [
        CONTRACT_HEADER,
        '06/10/2025\tICICIBANK\tD\tB\t250\t1363.40\t5.45\t1368.85',
        '06/10/2025\tRELIANCE\tT\tS\t100\t3000.00\t0.60\t2995.00',
        '06/10/2025\tExchange\tD\tB\t1000\t100.00\t0.00\t100.00', // totals row -> skipped
        '06/10/2025\tINVALID\tD\tB\t0\t100.00\t0.00\t0.00',      // qty <= 0 -> skipped
        '06/10/2025\tBADPRICE\tD\tB\t10\t\t0.00\t0.00'           // missing price -> skipped
    ].join('\n');

    const trades = await parseInput(tsv);
    assert.equal(trades.length, 2);

    const buy = trades[0];
    assert.equal(buy.symbol, 'ICICIBANK');
    assert.equal(buy.side, 'BUY');
    assert.equal(buy.qty, 250);
    assert.equal(buy.price, 1363.4);
    assert.equal(buy.expenses, 5.45); // per-share brokerage from the bps column
    assert.equal(buy.orderType, 'MTF');

    const sell = trades[1];
    assert.equal(sell.symbol, 'RELIANCE');
    assert.equal(sell.side, 'SELL');
    assert.equal(sell.orderType, 'MIS'); // TDInd T -> MIS
    assert.equal(sell.expenses, 0.6);
});

test('parseContractNoteTSV derives expenses from net rate when bps is empty, zero or absent', async () => {
    // Header still carries the Brokerage Per Share column so the contract-note
    // detector routes here; rows with an empty/zero bps fall back to net rate.
    const tsv = [
        'Trade Date\tScrip Symbol\tTDInd\tBuy/Sell\tQuantity\tRate\tBrokerage Per Share\tNet Rate',
        '06/10/2025\tICICIBANK\tD\tB\t250\t1363.40\t\t1368.85',
        '06/10/2025\tRELIANCE\tD\tS\t100\t3000.00\t0.00\t2996.00',
        '06/10/2025\tHDFC\tD\tB\t10\t100.00\t\t100.00' // diff < 0.01 -> null (estimate path)
    ].join('\n');

    const trades = await parseInput(tsv);
    assert.equal(trades.length, 3);
    closeTo(trades[0].expenses, 5.45); // buy: netRate - price
    closeTo(trades[1].expenses, 4.0);  // sell: price - netRate
    assert.equal(trades[2].expenses, null);
});

// ---------------------------------------------------------------- generic CSV

test('parseCSV maps known headers and preserves the product column', async () => {
    const csv = [
        'Date,Symbol,Qty,Price,Side,Product',
        '06/01/2025,TCS,10,4000,BUY,MIS',
        '06/01/2025,RELIANCE,5,2500,SELL,MTF'
    ].join('\n');

    const trades = await parseInput(csv);
    assert.equal(trades.length, 2);
    assert.equal(trades[0].orderType, 'MIS');
    assert.equal(trades[1].orderType, 'MTF');
});

test('non-MTF/MIS order types from CSV are silently dropped by processTrades', async () => {
    // normalizeTrade uppercases, but only exact MTF/MIS survive the delivery/intraday split.
    const csv = [
        'Date,Symbol,Qty,Price,Side,Product',
        '06/01/2025,TCS,10,4000,BUY,CNC',
        '06/01/2025,INFY,5,1000,BUY,mis',
        '06/01/2025,INFY,5,1100,SELL,mis'
    ].join('\n');

    const trades = await parseInput(csv);
    const res = json(getCtx(), `Calculator.processTrades(${JSON.stringify(trades)})`);

    assert.equal(res.closedPositions.length, 1);
    assert.equal(res.closedPositions[0].symbol, 'INFY'); // lowercase 'mis' normalized to MIS
    assert.equal(res.openPositions.length, 0);           // CNC buy vanished from both buckets
});

// ---------------------------------------------------------------- ledger format

test('parseLedgerFormat parses NSE/BSE lines with net-rate expenses and multi-word symbols', async () => {
    const ledger = [
        'NSE 06/10/2025 ICICIBANK D B 250 1363.40 1368.85',
        'BSE 06/10/2025 BANK OF INDIA T S 100 50.00 49.80'
    ].join('\n');

    const trades = await parseInput(ledger);
    assert.equal(trades.length, 2);

    assert.equal(trades[0].symbol, 'ICICIBANK');
    assert.equal(trades[0].side, 'BUY');
    assert.equal(trades[0].orderType, 'MTF'); // D -> MTF
    closeTo(trades[0].expenses, 5.45);

    assert.equal(trades[1].symbol, 'BANK OF INDIA');
    assert.equal(trades[1].side, 'SELL');
    assert.equal(trades[1].orderType, 'MIS'); // T -> MIS
    closeTo(trades[1].expenses, 0.2);
});

// ---------------------------------------------------------------- vertical blocks

test('parseVerticalBlocks parses legacy blocks with net-rate expenses', async () => {
    const blocks = [
        'NSE',
        '06/10/2025',
        'ICICIBANK',
        'D',
        'B',
        '250',
        '1363.40',
        '0',
        '1368.85',
        'NSE',
        '06/10/2025',
        'RELIANCE',
        'D',
        'S',
        '20',
        '3000.00',
        '0',
        '2996.00'
    ].join('\n');

    const trades = await parseInput(blocks);
    assert.equal(trades.length, 2);
    assert.equal(trades[0].symbol, 'ICICIBANK');
    closeTo(trades[0].expenses, 5.45);
    assert.equal(trades[1].symbol, 'RELIANCE');
    assert.equal(trades[1].side, 'SELL');
    closeTo(trades[1].expenses, 4.0);
});

// ---------------------------------------------------------------- live prices

test('fetchPrice returns the regular market price when the market is open', async () => {
    const seen = [];
    const res = await fetchPrice('RELIANCE', { marketOpen: true }, async (url) => {
        seen.push(url);
        return okFetch({ chart: { result: [{ meta: { regularMarketPrice: 101.5, previousClose: 100 } }] } })();
    });

    assert.deepEqual(res, { price: 101.5, source: 'regularMarketPrice' });
    assert.ok(seen[0].includes('api.allorigins.win'), 'routes through the CORS proxy');
    assert.ok(seen[0].includes('RELIANCE.NS'), 'queries the .NS symbol');
});

test('fetchPrice prefers previous close outside market hours', async () => {
    const res = await fetchPrice('RELIANCE', { marketOpen: false }, () =>
        okFetch({ chart: { result: [{ meta: { regularMarketPrice: 101.5, previousClose: 100 } }] } })()
    );
    assert.deepEqual(res, { price: 100, source: 'previousClose' });
});

test('fetchPrice returns null on network failure, bad response, malformed payload or empty data', async () => {
    const c = getCtx();

    c.fetch = async () => { throw new Error('network down'); };
    assert.equal(await run(c, 'DataHandler.fetchPrice("TCS", { marketOpen: true })'), null);

    c.fetch = async () => ({ ok: false });
    assert.equal(await run(c, 'DataHandler.fetchPrice("TCS", { marketOpen: true })'), null);

    c.fetch = async () => ({ ok: true, json: async () => ({ contents: 'not-json{' }) });
    assert.equal(await run(c, 'DataHandler.fetchPrice("TCS", { marketOpen: true })'), null);

    c.fetch = async () => okFetch({ chart: { result: [] } })();
    assert.equal(await run(c, 'DataHandler.fetchPrice("TCS", { marketOpen: true })'), null);

    delete c.fetch;
});
