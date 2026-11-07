'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadApp, run, json } = require('./helpers');

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

function processTrades(trades, overrides = {}) {
    return json(getCtx(), `Calculator.processTrades(${JSON.stringify(trades)}, ${JSON.stringify(overrides)})`);
}

function normalize(raw) {
    return json(getCtx(), `Calculator.normalizeTrade(${JSON.stringify(raw)})`);
}

function chargeMethod(expr) {
    return run(getCtx(), expr);
}

const buyT = (symbol, date, qty, price, orderType = 'MTF', expenses) =>
    ({ symbol, date, qty, price, side: 'BUY', orderType, expenses });
const sellT = (symbol, date, qty, price, orderType = 'MTF', expenses) =>
    ({ symbol, date, qty, price, side: 'SELL', orderType, expenses });

// ---------------------------------------------------------------- normalizeTrade

test('normalizeTrade standardizes side, symbol, qty, price and DD/MM/YYYY dates', () => {
    const t = normalize({ date: '15/01/2025', symbol: ' icici bank ', side: 'b', qty: -100, price: '1,234.50' });
    assert.equal(t.date, '2025-01-15T00:00:00.000Z');
    assert.equal(t.symbol, 'ICICI BANK');
    assert.equal(t.side, 'BUY');
    assert.equal(t.qty, 100);
    assert.equal(t.price, 1234.5);
    assert.equal(t.orderType, 'MTF'); // defaults when missing
});

test('normalizeTrade accepts dash/dot separators and 2-digit years', () => {
    for (const date of ['15-01-2025', '15.01.2025', '15/01/25']) {
        assert.equal(normalize({ date, symbol: 'x', side: 'S', qty: 1, price: 10 }).date, '2025-01-15T00:00:00.000Z', date);
    }
});

test('normalizeTrade parses ISO YYYY-MM-DD dates (broker/CSV export format)', () => {
    const d = normalize({ date: '2025-01-15', symbol: 'x', side: 'B', qty: 1, price: 10 });
    assert.equal(d.date, '2025-01-15T00:00:00.000Z');
    // dotted and datetime variants normalize the same way
    assert.equal(normalize({ date: '2025.10.06', symbol: 'x', side: 'B', qty: 1, price: 10 }).date, '2025-10-06T00:00:00.000Z');
    assert.equal(normalize({ date: '2025-01-05T10:00:00', symbol: 'x', side: 'B', qty: 1, price: 10 }).date, '2025-01-05T10:00:00.000Z');
});

// ---------------------------------------------------------------- processTrades: delivery (FIFO)

test('delivery round trip computes gross, charges, interest and realized P&L', () => {
    const res = processTrades([
        buyT('TCS', '01/01/2025', 100, 1000),
        sellT('TCS', '05/01/2025', 100, 1100)
    ]);

    assert.equal(res.openPositions.length, 0);
    assert.equal(res.closedPositions.length, 1);

    const cp = res.closedPositions[0];
    assert.equal(cp.symbol, 'TCS');
    assert.equal(cp.qty, 100);
    assert.equal(cp.grossPnL, 10000);

    const buyCharges = chargeMethod('Calculator.estimateDeliveryCharges(100, 1000, 400, "BUY")');
    const sellCharges = chargeMethod('Calculator.estimateDeliveryCharges(100, 1100, 440, "SELL")');
    closeTo(cp.totalCharges, buyCharges + sellCharges);
    closeTo(cp.netPnlTaxOnly, 10000 - cp.totalCharges);

    // interest = (buy qty*price + buy charges) * fundedRatio * annualRate/365 * daysHeld(4)
    const expectedInterest = (100000 + buyCharges) * 0.314 * (0.18 / 365) * 4;
    closeTo(cp.totalInterest, expectedInterest);
    closeTo(cp.realizedPnL, cp.netPnlTaxOnly - cp.totalInterest);

    const leg = cp.legs[0];
    assert.equal(leg.qty, 100);
    assert.equal(leg.buyPrice, 1000);
    assert.equal(leg.sellPrice, 1100);
    assert.equal(leg.daysHeld, 4);
    assert.equal(leg.interest, cp.totalInterest);
    assert.equal(leg.type, 'MTF');
});

test('partial sell leaves the correct open quantity with prorated leg charges', () => {
    const res = processTrades([
        buyT('TCS', '01/01/2025', 100, 1000),
        sellT('TCS', '02/01/2025', 40, 1050)
    ]);

    assert.equal(res.openPositions.length, 1);
    const op = res.openPositions[0];
    assert.equal(op.qty, 60);
    assert.equal(op.legs.length, 1);
    assert.equal(op.legs[0].qty, 60);

    const buyCharges = chargeMethod('Calculator.estimateDeliveryCharges(100, 1000, 400, "BUY")');
    closeTo(op.avgPrice, 1000 + buyCharges / 100); // remaining charges ride on 60 shares

    const cp = res.closedPositions[0];
    assert.equal(cp.qty, 40);
    assert.equal(cp.grossPnL, 40 * (1050 - 1000));
});

test('multiple buy lots are matched in FIFO order', () => {
    const res = processTrades([
        buyT('TCS', '01/01/2025', 10, 100),
        buyT('TCS', '02/01/2025', 10, 200),
        sellT('TCS', '03/01/2025', 15, 150)
    ]);

    const cp = res.closedPositions[0];
    assert.equal(cp.qty, 15);
    assert.equal(cp.grossPnL, 250); // 10*(150-100) + 5*(150-200)
    assert.equal(cp.legs.length, 2);
    assert.equal(cp.legs[0].qty, 10);
    assert.equal(cp.legs[0].buyPrice, 100);
    assert.equal(cp.legs[0].grossPnl, 500);
    assert.equal(cp.legs[1].qty, 5);
    assert.equal(cp.legs[1].buyPrice, 200);
    assert.equal(cp.legs[1].grossPnl, -250);

    // the 5 leftover shares fall under the 10-share open filter (see filter test)
    assert.equal(res.openPositions.length, 0);
});

test('uncovered sell records nothing and does not crash', () => {
    const res = processTrades([sellT('TCS', '01/01/2025', 100, 1000)]);
    assert.equal(res.closedPositions.length, 0);
    assert.equal(res.openPositions.length, 0);
});

test('selling more than held matches only the held quantity', () => {
    const res = processTrades([
        buyT('TCS', '01/01/2025', 10, 1000),
        sellT('TCS', '02/01/2025', 15, 1100)
    ]);

    assert.equal(res.closedPositions[0].qty, 10);
    assert.equal(res.closedPositions[0].grossPnL, 1000);
    assert.equal(res.openPositions.length, 0); // 0 shares left
});

test('fundedRatio override scales interest; 0 funding means no interest', () => {
    const trades = [
        buyT('TCS', '01/01/2025', 100, 1000),
        sellT('TCS', '05/01/2025', 100, 1100)
    ];

    const full = processTrades(trades, { fundedRatio: 1 }).closedPositions[0];
    const zero = processTrades(trades, { fundedRatio: 0 }).closedPositions[0];
    const dflt = processTrades(trades).closedPositions[0];

    closeTo(zero.totalInterest, 0);
    assert.equal(zero.realizedPnL, zero.netPnlTaxOnly);
    closeTo(full.totalInterest / dflt.totalInterest, 1 / 0.314, 0.0001);
});

test('same-day delivery has zero interest', () => {
    const res = processTrades([
        buyT('TCS', '01/01/2025', 100, 1000),
        sellT('TCS', '01/01/2025', 100, 1100)
    ]);
    const cp = res.closedPositions[0];
    assert.equal(cp.totalInterest, 0);
    assert.equal(cp.realizedPnL, cp.netPnlTaxOnly);
});

test('ISO-format trade dates compute correct days held and interest', () => {
    const res = processTrades([
        buyT('TCS', '2025-01-01', 100, 1000),
        sellT('TCS', '2025-01-05', 100, 1100)
    ]);
    const cp = res.closedPositions[0];
    assert.equal(cp.qty, 100);
    assert.equal(cp.legs[0].daysHeld, 4);
    assert.ok(cp.totalInterest > 0, 'interest must accrue once dates are valid');
});

test('open position days and interest honor the interestDelay override', () => {
    const trades = [buyT('TCS', '01/01/2025', 10, 1000)]; // fixed now = 2025-01-10 -> 9 days

    const res = processTrades(trades);
    const op = res.openPositions[0];
    assert.equal(op.daysHeld, 9);
    assert.equal(op.legs[0].days, 9);
    const interestNoDelay = op.legs[0].interest;

    const delayed = processTrades(trades, { interestDelay: 2 }).openPositions[0];
    assert.equal(delayed.daysHeld, 9); // headline days uses the raw oldest-buy date
    assert.equal(delayed.legs[0].days, 7);
    closeTo(delayed.legs[0].interest, interestNoDelay * 7 / 9);
});

test('open position breakeven price and daily interest are wired to the charge/interest model', () => {
    const res = processTrades([buyT('TCS', '01/01/2025', 10, 1000)]);
    const op = res.openPositions[0];

    const charges = chargeMethod('Calculator.estimateDeliveryCharges(10, 1000, 40, "BUY")');
    const interest = (10000 + charges) * 0.314 * (0.18 / 365) * 9;
    const totalCost = 10000 + charges + interest;

    closeTo(op.interestAmount, interest);
    closeTo(op.dailyInterest, (10000 + charges) * 0.314 * (0.18 / 365));
    closeTo(op.breakevenPrice, totalCost / 0.995 / 10, 0.01);
    assert.ok(op.targets['5'] > op.breakevenPrice);
});

test('open positions with fewer than 10 shares are filtered out', () => {
    const small = processTrades([buyT('TCS', '01/01/2025', 5, 1000)]);
    assert.equal(small.openPositions.length, 0);

    const big = processTrades([buyT('TCS', '01/01/2025', 10, 1000)]);
    assert.equal(big.openPositions.length, 1);

    const faded = processTrades([
        buyT('TCS', '01/01/2025', 100, 1000),
        sellT('TCS', '02/01/2025', 95, 1000)
    ]);
    assert.equal(faded.openPositions.length, 0); // 5 leftover shares vanish from open view
});

test('trades are date-sorted before FIFO matching', () => {
    const res = processTrades([
        { symbol: 'TCS', date: '05/01/2025', side: 'SELL', qty: 100, price: 1100, orderType: 'MTF' },
        { symbol: 'TCS', date: '01/01/2025', side: 'BUY', qty: 100, price: 1000, orderType: 'MTF' }
    ]);
    const cp = res.closedPositions[0];
    assert.equal(cp.qty, 100);
    assert.equal(cp.legs[0].buyPrice, 1000);
    assert.equal(cp.legs[0].sellPrice, 1100);
});

test('symbols are case-insensitive across trades', () => {
    const res = processTrades([
        { symbol: 'reliance', date: '01/01/2025', side: 'BUY', qty: 100, price: 1000, orderType: 'MTF' },
        { symbol: 'RELIANCE', date: '02/01/2025', side: 'SELL', qty: 100, price: 1050, orderType: 'MTF' }
    ]);
    assert.equal(res.closedPositions.length, 1);
    assert.equal(res.closedPositions[0].symbol, 'RELIANCE');
    assert.equal(res.closedPositions[0].qty, 100);
});

// ---------------------------------------------------------------- processTrades: intraday (day-wise)

test('intraday round trip uses intraday charges and no interest', () => {
    const res = processTrades([
        buyT('TCS', '01/01/2025', 100, 1000, 'MIS'),
        sellT('TCS', '01/01/2025', 100, 1050, 'MIS')
    ]);

    assert.equal(res.openPositions.length, 0);
    const cp = res.closedPositions[0];
    assert.equal(cp.qty, 100);
    assert.equal(cp.grossPnL, 5000);
    assert.equal(cp.intradayPnL, 5000);
    assert.equal(cp.totalInterest, 0);

    const buyCharges = chargeMethod('Calculator.estimateIntradayCharges(100, 1000, "BUY")');
    const sellCharges = chargeMethod('Calculator.estimateIntradayCharges(100, 1050, "SELL")');
    closeTo(cp.totalCharges, buyCharges + sellCharges);
    closeTo(cp.netPnlTaxOnly, 5000 - cp.totalCharges);
    assert.equal(cp.realizedPnL, cp.netPnlTaxOnly);

    const leg = cp.legs[0];
    assert.equal(leg.type, 'MIS');
    assert.equal(leg.daysHeld, 0);
    assert.equal(leg.interest, 0);
});

test('intraday explicit per-share expenses replace estimated brokerage', () => {
    const res = processTrades([
        buyT('TCS', '01/01/2025', 100, 1000, 'MIS', 0.5),
        sellT('TCS', '01/01/2025', 100, 1050, 'MIS')
    ]);
    const cp = res.closedPositions[0];

    const buyCharges = chargeMethod('Calculator.estimateIntradayChargesFromBrokerage(100, 1000, "BUY", 50)');
    const sellCharges = chargeMethod('Calculator.estimateIntradayCharges(100, 1050, "SELL")');
    closeTo(cp.totalCharges, buyCharges + sellCharges);
    // 0.5/share explicit brokerage must exceed the estimated 0.03% intraday brokerage
    assert.ok(buyCharges > chargeMethod('Calculator.estimateIntradayCharges(100, 1000, "BUY")'));
});

test('intraday unmatched quantity is dropped from results (day-wise closed only)', () => {
    const res = processTrades([
        buyT('TCS', '01/01/2025', 100, 1000, 'MIS'),
        sellT('TCS', '01/01/2025', 40, 1050, 'MIS')
    ]);
    assert.equal(res.closedPositions[0].qty, 40);
    assert.equal(res.openPositions.length, 0); // leftover 60 shares are not tracked
});

test('intraday buy with no sell produces no results', () => {
    const res = processTrades([buyT('TCS', '01/01/2025', 100, 1000, 'MIS')]);
    assert.equal(res.closedPositions.length, 0);
    assert.equal(res.openPositions.length, 0);
});

test('delivery and intraday legs for one symbol are aggregated in the same closed position', () => {
    const res = processTrades([
        buyT('TCS', '01/01/2025', 100, 1000, 'MTF'),
        sellT('TCS', '02/01/2025', 40, 1100, 'MTF'),
        buyT('TCS', '01/01/2025', 50, 1000, 'MIS'),
        sellT('TCS', '01/01/2025', 50, 1050, 'MIS')
    ]);

    assert.equal(res.openPositions[0].qty, 60); // delivery holding after partial close
    const cp = res.closedPositions[0];
    assert.equal(cp.qty, 90); // 40 delivery + 50 intraday
    assert.deepEqual(cp.legs.map(l => l.type).sort(), ['MIS', 'MTF']);
    assert.equal(cp.grossPnL, 4000 + 2500); // delivery + intraday gross
});

// ---------------------------------------------------------------- charge estimation

test('delivery/intraday charge estimates match pinned amounts', () => {
    // delivery buy 100x1000 @ 0.4% brokerage: brokerage 400 + STT 100 + txn 3.25
    // + sebi 0.10 + stamp 15 + GST 72.603
    closeTo(chargeMethod('Calculator.estimateDeliveryCharges(100, 1000, 400, "BUY")'), 590.953);
    // delivery sell 100x1100 @ 0.4% brokerage: no stamp duty on sell
    closeTo(chargeMethod('Calculator.estimateDeliveryCharges(100, 1100, 440, "SELL")'), 633.5483);
    closeTo(chargeMethod('Calculator.estimateBuyCharges(100, 1000)'), 590.953);
    closeTo(chargeMethod('Calculator.estimateIntradayCharges(100, 1000, "BUY")'), 42.353);
    closeTo(chargeMethod('Calculator.estimateIntradayCharges(100, 1050, "SELL")'), 67.57065);
    // intraday sell carries STT; intraday buy carries stamp duty
    assert.ok(chargeMethod('Calculator.estimateIntradayCharges(100, 1000, "SELL")') > chargeMethod('Calculator.estimateIntradayCharges(100, 1000, "BUY")'));
});

// ---------------------------------------------------------------- breakeven

test('calculateBreakeven merges CONFIG targets with the custom target', () => {
    const res = json(getCtx(), 'Calculator.calculateBreakeven(100000, 500, 1000, 100, 7)');

    closeTo(res.breakevenPrice, (100000 + 500 + 1000) / 0.995 / 100); // sell value * (1-0.005) covers cost
    closeTo(res.interestAmount, 1000);
    closeTo(res.totalCost, 101500);
    closeTo(res.targets[1], (100000 + 500 + 1000 + 1000) / 0.995 / 100);
    closeTo(res.targets[7], (100000 + 500 + 1000 + 7000) / 0.995 / 100);
    closeTo(res.targets[10], (100000 + 500 + 1000 + 10000) / 0.995 / 100); // from CONFIG.profitTargets
    assert.ok(res.targets[10] > res.targets[5]);
});
