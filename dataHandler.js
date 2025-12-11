class DataHandler {
    static async parseInput(input) {
        if (!input || input.trim().length === 0) return [];

        const cleaned = input.trim();

        // Detect format
        // 1. New Ledger Format: Starts with NSE/BSE followed by data on the same line
        // Regex check for: Start of line -> NSE/BSE -> Whitespace -> Date/Something (not just newline)
        const hasLedgerSignature = cleaned.split('\n').some(l => /^(NSE|BSE)\s+\S+/i.test(l.trim()));

        if (hasLedgerSignature) {
            return this.parseLedgerFormat(cleaned);
        }

        // 2. CSV/TSV with potential headers
        if (cleaned.includes('\t') || cleaned.includes(',')) {
            // Check if it really has headers we recognize
            const trades = this.parseCSV(cleaned);
            if (trades.length > 0) return trades;
        }

        // 3. Fallback: Vertical block format (legacy)
        return this.parseVerticalBlocks(cleaned);
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

    static parseLedgerFormat(text) {
        // Robust Regex Parsing for Ledger Format
        // Support both Tabs and Spaces. Handle Symbols with spaces.
        // Anchors: Exch ... Type(D/T) Side(B/S) ...

        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l);
        const trades = [];

        // Regex Explanation:
        // ^(NSE|BSE)       Group 1: Exchange
        // \s+              Whitespace
        // (\S+)            Group 2: Date (non-whitespace)
        // \s+              Whitespace
        // (.+?)            Group 3: Symbol (Lazy match until next group)
        // \s+              Whitespace
        // ([DT])           Group 4: Type (D or T)
        // \s+              Whitespace
        // ([BS])           Group 5: Side (B or S)
        // \s+              Whitespace
        // ([\d.,]+)        Group 6: Qty
        // \s+              Whitespace
        // ([\d.,]+)        Group 7: Price
        // \s+              Whitespace
        // (?:[\d.,]+)      Non-capturing: Intermediate col (Col 7 in sample)
        // \s+              Whitespace
        // ([\d.,]+)        Group 8: Net Rate (Col 8 in sample) - Optional capture
        const pattern = /^(NSE|BSE)\s+(\S+)\s+(.+?)\s+([DT])\s+([BS])\s+([\d.,]+)\s+([\d.,]+)(?:\s+[\d.,]+)?\s+([\d.,]+)/i;

        for (const line of lines) {
            // Heuristic: Must start with NSE or BSE
            if (!line.startsWith('NSE') && !line.startsWith('BSE')) continue;

            const match = line.match(pattern);
            if (!match) {
                // Fallback for lines that might be simpler or header-like?
                // If it doesn't match the D/B pattern, maybe it's not a trade line.
                continue;
            }

            try {
                const exch = match[1];
                const date = match[2];
                const symbol = match[3].trim();
                const typeCode = match[4];
                const sideCode = match[5];
                const qty = parseFloat(match[6].replace(/,/g, ''));
                const price = parseFloat(match[7].replace(/,/g, ''));

                // Net Rate (Group 8)
                let netRate = price;
                if (match[8]) {
                    netRate = parseFloat(match[8].replace(/,/g, ''));
                    if (isNaN(netRate)) netRate = price;
                }

                // implicit costs calculation
                let expenses = null;
                // If we found a valid Net Rate different from 0
                if (match[8]) {
                    if (sideCode === 'B') {
                        expenses = Math.max(0, netRate - price);
                    } else {
                        expenses = Math.max(0, price - netRate);
                    }
                    if (expenses < 0.01) expenses = null; // Treat ~0 or 0 expenses as null to trigger estimation
                }
                // Safety check
                if (isNaN(qty) || isNaN(price)) continue;

                trades.push({
                    date: date,
                    symbol: symbol,
                    side: sideCode === 'B' ? 'BUY' : 'SELL',
                    qty: qty,
                    price: price,
                    expenses: expenses,
                    orderType: typeCode === 'D' ? 'MTF' : 'MIS'
                });

            } catch (e) {
                console.warn("Skipping malformed line:", line, e);
            }
        }

        return trades;
    }

    static parseVerticalBlocks(text) {
        // Legacy vertical block format
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

                        let expenses = null;
                        let netPrice = price;
                        // Try to peek ahead for Net Rate (i+8)
                        if (lines[i + 8] && !isNaN(parseFloat(lines[i + 8]))) {
                            netPrice = parseFloat(lines[i + 8]);
                            if (sideCode === 'B') {
                                expenses = Math.max(0, netPrice - price);
                            } else {
                                expenses = Math.max(0, price - netPrice);
                            }
                            if (expenses === 0) expenses = null;
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

    // Live Price Integration
    static async fetchPrice(symbol, { marketOpen = false } = {}) {
        try {
            // Yahoo Finance API via AllOrigins Proxy (to bypass CORS on file://)
            const ySymbol = `${symbol}.NS`;
            const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ySymbol}?interval=1d&range=1d`;

            // Proxy URL - This wraps the request so the browser sees a request to allorigins.win (CORS friendly)
            const url = `https://api.allorigins.win/get?url=${encodeURIComponent(yUrl)}`;

            const response = await fetch(url);

            if (!response.ok) throw new Error("Network response was not ok");

            const proxyData = await response.json();
            // AllOrigins returns the actual response in 'contents' field as a string
            const data = JSON.parse(proxyData.contents);

            // Validate structure
            if (!data.chart || !data.chart.result || data.chart.result.length === 0) {
                console.warn(`Yahoo API: No data for ${ySymbol}`);
                return null;
            }

            const meta = data.chart.result[0].meta;

            // Yahoo Meta Fields: regularMarketPrice, previousClose, regularMarketOpen
            const currentPrice = meta.regularMarketPrice;
            const prevClose = meta.previousClose;

            // Decide source based on market status
            if (marketOpen) {
                return { price: currentPrice || prevClose || 0, source: 'regularMarketPrice' };
            }
            return { price: prevClose || currentPrice || 0, source: 'previousClose' };

        } catch (e) {
            console.error(`Failed to fetch price for ${symbol}`, e);
            return null;
        }
    }
}
