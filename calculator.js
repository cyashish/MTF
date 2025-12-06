class Calculator {
    static normalizeTrade(rawTrade) {
        // Safe conversion helpers
        const parseNum = (val) => {
            if (typeof val === 'number') return val;
            if (!val) return 0;
            return parseFloat(String(val).replace(/,/g, ''));
        };

        const parseDate = (dateStr) => {
            if (!dateStr) return new Date();
            let clean = dateStr.trim();
            // Normalize separators: replace - and . with /
            clean = clean.replace(/[-.]/g, '/');

            // Handle DD/MM/YYYY
            if (clean.includes('/')) {
                const parts = clean.split('/');
                if (parts.length === 3) {
                    let [d, m, y] = parts;
                    // Handle 2-digit year
                    if (y.length === 2) y = '20' + y;
                    return new Date(`${y}-${m}-${d}`);
                }
            }
            return new Date(dateStr);
        };

        const isBuy = rawTrade.side.trim().toUpperCase() === 'B' || rawTrade.side.trim().toUpperCase() === 'BUY';

        return {
            date: parseDate(rawTrade.date),
            originalDateStr: rawTrade.date, // Store raw string for debugging
            symbol: rawTrade.symbol.trim().toUpperCase(),
            side: isBuy ? 'BUY' : 'SELL',
            qty: Math.abs(parseNum(rawTrade.qty)),
            price: parseNum(rawTrade.price),
            expenses: rawTrade.expenses || 0, // Pass through explicit expenses from file
            orderType: rawTrade.orderType ? rawTrade.orderType.trim().toUpperCase() : 'MTF',
            raw: rawTrade
        };
    }

    static processTrades(rawTrades, configOverrides = {}) {
        // 1. Normalize
        const trades = rawTrades.map(this.normalizeTrade);

        // 2. Sort by Date
        trades.sort((a, b) => a.date - b.date);

        // 3. FIFO Engine
        const positions = {};
        const closedPositions = {}; // New storage for closed trades

        trades.forEach(trade => {
            // Ensure Position Object Exists
            if (!positions[trade.symbol]) {
                positions[trade.symbol] = {
                    symbol: trade.symbol,
                    buyQueue: [],
                    totalOpenQty: 0,
                    realizedPnL: 0
                };
            }
            // Ensure Closed Position Object Exists
            if (!closedPositions[trade.symbol]) {
                closedPositions[trade.symbol] = {
                    symbol: trade.symbol,
                    totalClosedQty: 0,
                    realizedPnL: 0,
                    legs: []
                };
            }

            const pos = positions[trade.symbol];
            const closedPos = closedPositions[trade.symbol];

            if (trade.side === 'BUY') {
                // If expenses are provided (from file), use them. Else estimate.
                let charges = trade.expenses * trade.qty;
                if (!trade.expenses && trade.expenses !== 0) {
                    charges = this.estimateBuyCharges(trade.qty, trade.price);
                }

                pos.buyQueue.push({
                    qty: trade.qty,
                    price: trade.price,
                    date: trade.date,
                    originalDateStr: trade.originalDateStr,
                    orderType: trade.orderType,
                    charges: charges, // Total charges for this lot
                    expensesPerUnit: charges / trade.qty
                });
                pos.totalOpenQty += trade.qty;
            } else {
                // SELL
                let qtyToSell = trade.qty;

                // Calculate sell-side expenses per unit for this specific sell order
                let totalSellCharges = trade.expenses * trade.qty;
                if (!trade.expenses && trade.expenses !== 0) {
                    // Estimate if not provided using detailed CONFIG
                    // Sell side: Brokerage + STT + Txn + Sebi + GST
                    const turnover = trade.qty * trade.price;
                    const brokerage = turnover * CONFIG.brokerage;
                    const stt = turnover * CONFIG.sttSell;
                    const txn = turnover * CONFIG.txnCharge;
                    const sebi = turnover * CONFIG.sebiCharge;
                    const gst = (brokerage + txn + sebi) * CONFIG.gst; // GST is on Brkg + Txn + Sebi (usually)

                    totalSellCharges = brokerage + stt + txn + sebi + gst;
                }
                let sellExpensesPerUnit = totalSellCharges / trade.qty;

                while (qtyToSell > 0 && pos.buyQueue.length > 0) {
                    const matchLeg = pos.buyQueue[0];
                    let matchedQty = 0;

                    if (matchLeg.qty <= qtyToSell) {
                        // Full match of this buy leg
                        matchedQty = matchLeg.qty;
                        qtyToSell -= matchLeg.qty;
                        pos.totalOpenQty -= matchLeg.qty;
                        pos.buyQueue.shift();
                    } else {
                        // Partial match
                        matchedQty = qtyToSell;
                        matchLeg.qty -= matchedQty;
                        // Pro-rate remaining charges on the buy leg
                        matchLeg.charges -= (matchLeg.expensesPerUnit * matchedQty);
                        pos.totalOpenQty -= matchedQty;
                        qtyToSell = 0;
                    }

                    // --- P&L VARIABLES ---
                    const buyCost = matchedQty * matchLeg.price;
                    const buyExp = matchedQty * matchLeg.expensesPerUnit;
                    const sellVal = matchedQty * trade.price;
                    const sellExp = matchedQty * sellExpensesPerUnit;

                    // --- INTEREST CALCULATION (Realized) ---
                    const daysHeld = Math.max(0, Math.round((trade.date - matchLeg.date) / (24 * 60 * 60 * 1000)));
                    const annualRate = CONFIG.mtfInterestRate;
                    const fundedRatio = configOverrides.fundedRatio || 1.0;

                    const legDebit = buyCost + buyExp; // Total cost to be funded
                    const legLoan = legDebit * fundedRatio;
                    const interest = legLoan * (annualRate / 365) * daysHeld;

                    // --- NET P&L ---
                    // Gross P&L = Sold Value - Buy Cost - Buy Expenses - Sell Expenses
                    const grossPnl = sellVal - buyCost - buyExp - sellExp;
                    const netPnl = grossPnl - interest;

                    pos.realizedPnL += netPnl;

                    closedPos.grossPnL = (closedPos.grossPnL || 0) + grossPnl;
                    closedPos.realizedPnL += netPnl;
                    closedPos.totalInterest = (closedPos.totalInterest || 0) + interest;
                    closedPos.totalClosedQty += matchedQty;

                    closedPos.legs.push({
                        symbol: trade.symbol,
                        qty: matchedQty,
                        buyDate: matchLeg.date,
                        buyPrice: matchLeg.price,
                        sellDate: trade.date,
                        sellPrice: trade.price,
                        grossPnl: grossPnl,
                        netPnl: netPnl,
                        daysHeld: daysHeld,
                        interest: interest,
                        type: 'MTF'
                    });
                }
            }
        });

        // 4. Update Open Positions Results
        const openResults = [];

        // Constants for Interest Calc
        const today = new Date();
        const oneDay = 24 * 60 * 60 * 1000;
        const fundedRatio = configOverrides.fundedRatio || 1.0;
        const interestDelay = configOverrides.interestDelay || 0;
        const annualRate = CONFIG.mtfInterestRate;
        const customTargetPct = configOverrides.customTarget || 10;

        Object.values(positions).forEach(p => {
            if (p.totalOpenQty > 0) {
                let totalCostClean = 0; // Pure share price cost
                let totalCharges = 0;   // Brokerage/Taxes paid
                let totalInterest = 0;
                let totalQty = 0;
                let oldestDate = new Date();

                let detailedLegs = [];

                p.buyQueue.forEach(leg => {
                    totalCostClean += leg.qty * leg.price;
                    totalCharges += leg.charges;
                    totalQty += leg.qty;
                    if (leg.date < oldestDate) oldestDate = leg.date;

                    // Independent Interest Calculation per Lot
                    let daysHeld = Math.round((today - leg.date) / oneDay) - interestDelay;
                    daysHeld = Math.max(0, daysHeld);

                    const legDebit = (leg.qty * leg.price) + leg.charges;
                    const legLoan = legDebit * fundedRatio;
                    const legInterest = legLoan * (annualRate / 365) * daysHeld;

                    totalInterest += legInterest;

                    detailedLegs.push({
                        qty: leg.qty,
                        price: leg.price,
                        date: leg.date,
                        charges: leg.charges,
                        days: daysHeld,
                        interest: legInterest,
                        rawDate: leg.originalDateStr // Debug info
                    });
                });

                // Effective Average Price includes the charges paid!
                const effectiveAvgPrice = (totalCostClean + totalCharges) / totalQty;

                // For Breakeven calc, we pass the pre-calculated total interest
                const breakeven = this.calculateBreakeven(
                    totalCostClean,
                    totalCharges,
                    totalInterest,
                    totalQty,
                    customTargetPct
                );

                openResults.push({
                    symbol: p.symbol,
                    qty: totalQty,
                    avgPrice: effectiveAvgPrice,
                    buyDate: oldestDate,
                    daysHeld: Math.round((today - oldestDate) / oneDay), // Oldest days
                    legs: detailedLegs,
                    ...breakeven
                });
            }
        });

        // 5. Pack Closed Results
        // Filter out symbols with no closed trades
        const closedResults = Object.values(closedPositions)
            .filter(cp => cp.totalClosedQty > 0)
            .map(cp => ({
                symbol: cp.symbol,
                qty: cp.totalClosedQty,
                grossPnL: cp.grossPnL || 0,
                realizedPnL: cp.realizedPnL,
                totalInterest: cp.totalInterest || 0,
                legs: cp.legs
            }));

        return { openPositions: openResults, closedPositions: closedResults };
    }

    static estimateBuyCharges(qty, price) {
        // Detailed estimation for Buy Side (Delivery)
        const turnover = qty * price;
        const brokerage = turnover * CONFIG.brokerage;
        const stt = turnover * 0.001; // STT on Delivery Buy is 0.1%
        const txn = turnover * CONFIG.txnCharge;
        const sebi = turnover * CONFIG.sebiCharge;
        const stamp = turnover * CONFIG.stampDuty; // Stamp duty only on buy
        const gst = (brokerage + txn + sebi) * CONFIG.gst;

        return brokerage + stt + txn + sebi + stamp + gst;
    }

    static calculateBreakeven(buyValueRaw, buyCharges, totalInterest, qty, customTargetPct) {
        // Buy Value (Raw)
        const buyValue = buyValueRaw;

        // Total Cost (Debit + Interest)
        // buyCharges are actuals/detailed (as requested for P&L tracking)
        const totalDebit = buyValue + buyCharges;

        // Sell Side Factor K (Future Expense Approximation)
        // User requested 0.05 approx (interpreted as 0.5% = 0.005 standard buffer)
        // This decouples target prediction from detailed tax logic, providing a safe buffer.
        const K = 0.005; // 0.5% flat approximation for target estimation

        // SellValue * (1 - K) = TotalDebit + TotalInterest
        const totalCostToCheck = totalDebit + totalInterest;
        const requiredSellValue = totalCostToCheck / (1 - K);
        const breakevenPrice = requiredSellValue / qty;

        // Targets
        const targets = {};

        // Merge standard CONFIG targets with the custom one to ensure it's calculated
        const targetsToCalc = new Set([...CONFIG.profitTargets, customTargetPct]);

        targetsToCalc.forEach(pct => {
            const targetNetProfit = (buyValue * pct) / 100;
            const requiredSellVal = (totalCostToCheck + targetNetProfit) / (1 - K);
            targets[pct] = requiredSellVal / qty;
        });

        return {
            breakevenPrice,
            interestAmount: totalInterest,
            totalCost: totalCostToCheck,
            targets
        };
    }
}
