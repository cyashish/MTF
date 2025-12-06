class DataHandler {
    static async parseInput(input) {
        if (!input || input.trim().length === 0) return [];

        const cleaned = input.trim();

        // Detect format
        if (cleaned.includes('\t') || cleaned.includes(',')) {
            return this.parseCSV(cleaned);
        } else {
            // Assume vertical block format (from user sample)
            return this.parseVerticalBlocks(cleaned);
        }
    }

    static parseCSV(text) {
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        const delimiter = lines[0].includes('\t') ? '\t' : ',';

        // Headers
        const headers = lines[0].split(delimiter).map(h => h.trim().toLowerCase());
        const map = CONFIG.columnMapping;

        const getIdx = (candidates) => headers.findIndex(h => candidates.some(c => h.includes(c)));

        const indices = {
            date: getIdx(map.date),
            symbol: getIdx(map.symbol),
            side: getIdx(map.side),
            qty: getIdx(map.qty),
            price: getIdx(map.price),
            orderType: getIdx(map.orderType)
        };

        const trades = [];
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(delimiter).map(c => c.trim());
            if (cols.length < 5) continue;

            trades.push({
                date: indices.date > -1 ? cols[indices.date] : new Date().toISOString(),
                symbol: indices.symbol > -1 ? cols[indices.symbol] : 'UNKNOWN',
                side: indices.side > -1 ? cols[indices.side] : 'BUY',
                qty: indices.qty > -1 ? parseFloat(cols[indices.qty]) : 0,
                price: indices.price > -1 ? parseFloat(cols[indices.price]) : 0,
                orderType: indices.orderType > -1 ? cols[indices.orderType] : 'MTF'
            });
        }
        return trades;
    }

    static parseVerticalBlocks(text) {
        // User specific format handler
        // Expecting specific sequence like: Exch, Date, Symbol, Type, Side, Qty, Price...

        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l);
        const trades = [];

        // We look for the "Exchange" keyword (NSE/BSE) to start a block
        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            if (line === 'NSE' || line === 'BSE') {
                if (i + 6 < lines.length) {
                    try {
                        const date = lines[i + 1];    // 06/10/2025
                        const symbol = lines[i + 2];  // ICICIBANK
                        const typeCode = lines[i + 3]; // D or T
                        const sideCode = lines[i + 4]; // B or S
                        const qty = parseFloat(lines[i + 5]);     // 250
                        const price = parseFloat(lines[i + 6]);   // 1363.40

                        let netPrice = price;
                        // Try to peek ahead for Net Rate (i+8)
                        // Pattern: Qty(5), Price(6), Brok(7), NetRate(8)
                        if (lines[i + 8] && !isNaN(parseFloat(lines[i + 8]))) {
                            netPrice = parseFloat(lines[i + 8]);
                        }

                        // Calculate implicit costs per share from the file data if available
                        let expenses = 0;
                        if (sideCode === 'B') {
                            expenses = Math.max(0, netPrice - price);
                        } else {
                            expenses = Math.max(0, price - netPrice);
                        }

                        trades.push({
                            date,
                            symbol,
                            side: sideCode === 'B' ? 'BUY' : 'SELL',
                            qty: qty,
                            price: price,
                            expenses: expenses, // Per share expense from file
                            orderType: typeCode === 'D' ? 'MTF' : 'MIS'
                        });

                        i += 7; // Advance
                    } catch (e) {
                        console.warn("Failed to parse block at line " + i, e);
                        i++;
                    }
                } else {
                    i++;
                }
            } else {
                i++;
            }
        }

        return trades;
    }
}
