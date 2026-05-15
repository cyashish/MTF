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
            expenses: rawTrade.expenses, // Pass through explicit expenses (null if missing)
            orderType: rawTrade.orderType ? rawTrade.orderType.trim().toUpperCase() : 'MTF',
            raw: rawTrade
        };
    }

    static processTrades(rawTrades, configOverrides = {}) {
        // 1. Normalize
        const trades = rawTrades.map(this.normalizeTrade);

        // 2. Sort by Date
        trades.sort((a, b) => a.date - b.date);

        // 3. Separate Logic for Delivery (FIFO) vs Intraday (Day-wise)
        const deliveryTrades = trades.filter(t => t.orderType === 'MTF');
        const intradayTrades = trades.filter(t => t.orderType === 'MIS');

        const positions = {};
        const closedPositions = {}; // Storage for closed trades

        // --- PART A: DELIVERY (FIFO) ---
        deliveryTrades.forEach(trade => {
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
                    legs: [],
                    // Intraday stats specific
                    intradayPnL: 0,
                    intradayQty: 0
                };
            }

            const pos = positions[trade.symbol];
            const closedPos = closedPositions[trade.symbol];

            if (trade.side === 'BUY') {
                // Calculation matches previous logic
                let brokerageAmount = 0;
                if (trade.expenses != null && trade.expenses > 0) {
                    brokerageAmount = trade.expenses * trade.qty;
                } else {
                    brokerageAmount = (trade.qty * trade.price) * CONFIG.brokerage;
                }

                // Calculate Delivery Charges (Buy)
                // STT on Delivery Buy = 0.1%
                const stt = (trade.qty * trade.price) * 0.001;

                // We restart standard calculation excluding STT to avoid double calc if we used helper
                // Actually, let's just use a clean calculation block here
                const turnover = trade.qty * trade.price;
                const txn = turnover * CONFIG.txnCharge;
                const sebi = turnover * CONFIG.sebiCharge;
                const stamp = turnover * CONFIG.stampDuty; // Buy side stamp
                const gst = (brokerageAmount + txn + sebi) * CONFIG.gst;

                const charges = brokerageAmount + stt + txn + sebi + stamp + gst;

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

                // Validate Expenses
                let totalSellCharges = 0;
                if (trade.expenses != null && trade.expenses > 0) {
                    totalSellCharges = trade.expenses * trade.qty;
                } else {
                    const turnover = trade.qty * trade.price;
                    const brokerage = turnover * CONFIG.brokerage;
                    const stt = turnover * CONFIG.sttSell;
                    const txn = turnover * CONFIG.txnCharge;
                    const sebi = turnover * CONFIG.sebiCharge;
                    const gst = (brokerage + txn + sebi) * CONFIG.gst;
                    totalSellCharges = brokerage + stt + txn + sebi + gst;
                }
                let sellExpensesPerUnit = totalSellCharges / trade.qty;

                while (qtyToSell > 0 && pos.buyQueue.length > 0) {
                    const matchLeg = pos.buyQueue[0];
                    let matchedQty = 0;

                    if (matchLeg.qty <= qtyToSell) {
                        matchedQty = matchLeg.qty;
                        qtyToSell -= matchLeg.qty;
                        pos.totalOpenQty -= matchLeg.qty;
                        pos.buyQueue.shift();
                    } else {
                        matchedQty = qtyToSell;
                        matchLeg.qty -= matchedQty;
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
                    let daysHeld = Math.round((trade.date - matchLeg.date) / (24 * 60 * 60 * 1000));
                    if (isNaN(daysHeld)) daysHeld = 0;
                    daysHeld = Math.max(0, daysHeld);

                    const annualRate = CONFIG.mtfInterestRate;
                    const fundedRatio = configOverrides.fundedRatio !== undefined ? configOverrides.fundedRatio : (CONFIG.fundedRatio !== undefined ? CONFIG.fundedRatio : 1.0);

                    const legDebit = buyCost + buyExp;
                    const legLoan = legDebit * fundedRatio;

                    let interest = legLoan * (annualRate / 365) * daysHeld;
                    if (isNaN(interest)) interest = 0;

                    const grossPnl = sellVal - buyCost;
                    const totalCharges = buyExp + sellExp;
                    const netPnlTaxOnly = grossPnl - totalCharges;
                    let netPnlTotal = netPnlTaxOnly - interest;
                    if (isNaN(netPnlTotal)) netPnlTotal = 0;

                    pos.realizedPnL += netPnlTotal;

                    closedPos.grossPnL = (closedPos.grossPnL || 0) + grossPnl;
                    closedPos.totalCharges = (closedPos.totalCharges || 0) + totalCharges;
                    closedPos.netPnlTaxOnly = (closedPos.netPnlTaxOnly || 0) + netPnlTaxOnly;
                    closedPos.realizedPnL += netPnlTotal;
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
                        charges: totalCharges,
                        netPnlTaxOnly: netPnlTaxOnly,
                        pnl: netPnlTotal,
                        daysHeld: daysHeld,
                        interest: interest,
                        type: 'MTF'
                    });
                }
            }
        });

        // --- PART B: INTRADAY (Day-wise) ---
        // Group by Symbol + Date
        const intradayGroups = {};
        intradayTrades.forEach(t => {
            const dateKey = t.date.toISOString().split('T')[0]; // YYYY-MM-DD
            const key = `${t.symbol}|${dateKey}`;
            if (!intradayGroups[key]) {
                intradayGroups[key] = {
                    symbol: t.symbol,
                    date: t.date,
                    buys: [],
                    sells: []
                };
            }
            if (t.side === 'BUY') intradayGroups[key].buys.push(t);
            else intradayGroups[key].sells.push(t);
        });

        Object.values(intradayGroups).forEach(group => {
            // Aggregate Day Stats
            const totalBuyQty = group.buys.reduce((sum, t) => sum + t.qty, 0);
            const totalSellQty = group.sells.reduce((sum, t) => sum + t.qty, 0);

            // We match only the MIN(buy, sell) as completed intraday volume
            const matchedQty = Math.min(totalBuyQty, totalSellQty);

            if (matchedQty > 0) {
                // Weighted Average Buy Price
                let totalBuyVal = 0;
                let totalBuyExp = 0;
                group.buys.forEach(t => {
                    totalBuyVal += t.qty * t.price;
                    // Calculate expenses if missing
                    if (t.expenses === null || t.expenses === undefined) {
                        t.expenses = this.estimateIntradayCharges(t.qty, t.price, 'BUY') / t.qty;
                    }
                    totalBuyExp += t.qty * t.expenses;
                });
                const avgBuyPrice = totalBuyVal / totalBuyQty;
                const avgBuyExp = totalBuyExp / totalBuyQty;

                // Weighted Average Sell Price
                let totalSellVal = 0;
                let totalSellExp = 0;
                group.sells.forEach(t => {
                    totalSellVal += t.qty * t.price;
                    if (t.expenses === null || t.expenses === undefined) {
                        t.expenses = this.estimateIntradayCharges(t.qty, t.price, 'SELL') / t.qty;
                    }
                    totalSellExp += t.qty * t.expenses;
                });
                const avgSellPrice = totalSellVal / totalSellQty;
                const avgSellExp = totalSellExp / totalSellQty;

                // Calculate PnL on Matched Qty
                const buyCost = matchedQty * avgBuyPrice;
                const buyCharges = matchedQty * avgBuyExp;
                const sellVal = matchedQty * avgSellPrice;
                const sellCharges = matchedQty * avgSellExp;

                const grossPnl = sellVal - buyCost;
                const totalCharges = buyCharges + sellCharges;
                const netPnlTaxOnly = grossPnl - totalCharges;

                // Update Closed Position Stats
                if (!closedPositions[group.symbol]) {
                    closedPositions[group.symbol] = {
                        symbol: group.symbol,
                        totalClosedQty: 0,
                        realizedPnL: 0,
                        legs: [],
                        intradayPnL: 0,
                        intradayQty: 0
                    };
                }
                const cp = closedPositions[group.symbol];

                // Add to totals
                cp.realizedPnL += netPnlTaxOnly;
                cp.grossPnL = (cp.grossPnL || 0) + grossPnl;
                cp.totalCharges = (cp.totalCharges || 0) + totalCharges;
                cp.netPnlTaxOnly = (cp.netPnlTaxOnly || 0) + netPnlTaxOnly;
                cp.totalClosedQty += matchedQty; // Technically it's volume, but for PnL summary effectively closed
                cp.intradayPnL = (cp.intradayPnL || 0) + grossPnl;
                cp.intradayQty = (cp.intradayQty || 0) + matchedQty;

                // Add a summary leg
                cp.legs.push({
                    symbol: group.symbol,
                    qty: matchedQty,
                    buyDate: group.date,
                    buyPrice: avgBuyPrice,
                    sellDate: group.date,
                    sellPrice: avgSellPrice,
                    grossPnl: grossPnl,
                    pnl: netPnlTaxOnly,
                    daysHeld: 0,
                    interest: 0,
                    type: 'MIS' // Marker
                });
            }
        });


        // 4. Update Open Positions Results
        const openResults = [];

        // Constants for Interest Calc
        const today = new Date();
        const oneDay = 24 * 60 * 60 * 1000;
        const fundedRatio = configOverrides.fundedRatio !== undefined ? configOverrides.fundedRatio : (CONFIG.fundedRatio !== undefined ? CONFIG.fundedRatio : 1.0);
        const interestDelay = configOverrides.interestDelay || 0;
        const annualRate = CONFIG.mtfInterestRate;
        const customTargetPct = configOverrides.customTarget || 10;

        Object.values(positions).forEach(p => {
            // Filter out small positions (< 10 qty)
            if (p.totalOpenQty >= 10) {
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
                    if (isNaN(daysHeld)) daysHeld = 0;
                    daysHeld = Math.max(0, daysHeld);
                    const legDebit = (leg.qty * leg.price) + leg.charges;
                    const legLoan = legDebit * fundedRatio;

                    let legInterest = legLoan * (annualRate / 365) * daysHeld;
                    if (isNaN(legInterest)) legInterest = 0;

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

                // Total Daily Interest for this position
                const totalDailyInterest = p.buyQueue.reduce((sum, leg) => {
                    const legDebit = (leg.qty * leg.price) + leg.charges;
                    const legLoan = legDebit * fundedRatio;
                    return sum + (legLoan * (annualRate / 365));
                }, 0);

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
                    dailyInterest: totalDailyInterest, // New field
                    legs: detailedLegs,
                    ...breakeven
                });
            }
        });

        // 5. Pack Closed Results
        // Filter out symbols with no closed trades
        const closedResults = Object.values(closedPositions)
            .filter(cp => cp.totalClosedQty > 0)
            .map(cp => {
                const totalCharges = cp.totalCharges || 0;
                const netPnlTaxOnly = cp.netPnlTaxOnly || 0;
                const totalInterest = cp.totalInterest || 0;
                return {
                    symbol: cp.symbol,
                    qty: cp.totalClosedQty,
                    grossPnL: cp.grossPnL || 0,
                    totalCharges,
                    netPnlTaxOnly,
                    totalInterest,
                    realizedPnL: netPnlTaxOnly - totalInterest,
                    intradayPnL: cp.intradayPnL || 0,
                    legs: cp.legs
                };
            });

        return { openPositions: openResults, closedPositions: closedResults };
    }

    static calculateTaxesOnly(qty, price, brokerageAmount, isDelivery = true) {
        // Calculates non-brokerage costs: STT, Txn, Sebi, Stamp, GST
        const turnover = qty * price;

        let stt = 0;
        if (isDelivery) {
            stt = turnover * 0.001; // STT on Delivery Buy is 0.1% (Standard)
        } else {
            // Intraday: STT is on Sell only (usually). 0.025%
            // But this method doesn't know side. We'll assume this is called wisely.
            // If it's a Buy, Intraday STT is 0. If Sell, 0.025%
            // However, this helper is generic. 
            // IMPROVEMENT: Pass side or split logic.
            // For now, if isDelivery=false, we'll assume caller handles STT separately or we use a blended approach?
            // Actually, best to pass STT rate or handle it in specific estimate methods.
            // Let's assume standard behavior:
            // If calling for general taxes, we might just apply the sell-side STT rate?
            stt = turnover * (CONFIG.sttIntraday || 0.00025);
        }

        const txn = turnover * CONFIG.txnCharge;
        const sebi = turnover * CONFIG.sebiCharge;
        const stamp = turnover * CONFIG.stampDuty; // Stamp duty only on buy typically, but here we lump it

        // GST is on Brokerage + Txn + Sebi
        const gst = (brokerageAmount + txn + sebi) * CONFIG.gst;

        return stt + txn + sebi + stamp + gst;
    }

    static estimateBuyCharges(qty, price) {
        // Detailed estimation for Buy Side (Delivery)
        const turnover = qty * price;
        const brokerage = turnover * CONFIG.brokerage;
        // Delivery Buy STT = 0.1%
        const stt = turnover * 0.001;

        const txn = turnover * CONFIG.txnCharge;
        const sebi = turnover * CONFIG.sebiCharge;
        const stamp = turnover * CONFIG.stampDuty;
        const gst = (brokerage + txn + sebi) * CONFIG.gst;

        return brokerage + stt + txn + sebi + stamp + gst;
    }

    static estimateIntradayCharges(qty, price, side) {
        const turnover = qty * price;
        const brokerage = turnover * CONFIG.brokerageIntraday;

        // STT Intraday: 0 on Buy, 0.025% on Sell
        const stt = side === 'SELL' ? (turnover * CONFIG.sttIntraday) : 0;

        const txn = turnover * CONFIG.txnCharge;
        const sebi = turnover * CONFIG.sebiCharge;
        // Stamp Duty: 0.003% on Buy (usually), 0 on Sell
        const stamp = side === 'BUY' ? (turnover * 0.00003) : 0;

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
