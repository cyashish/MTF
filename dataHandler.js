class DataHandler {
    /**
     * Convert an Excel file (ArrayBuffer or Uint8Array) to CSV text.
     * Returns the CSV string from the first sheet, or null if not a valid workbook.
     */
    static excelToCSV(arrayBuffer) {
        try {
            if (typeof XLSX === 'undefined') {
                console.error('SheetJS (XLSX) library not loaded');
                return null;
            }
            const data = arrayBuffer instanceof ArrayBuffer ? new Uint8Array(arrayBuffer) : arrayBuffer;
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheetName = workbook.SheetNames[0];
            if (!firstSheetName) return null;
            const sheet = workbook.Sheets[firstSheetName];
            return XLSX.utils.sheet_to_csv(sheet);
        } catch (e) {
            console.warn('Failed to parse as Excel:', e);
            return null;
        }
    }

    /**
     * Check if a filename has an Excel extension.
     */
    static isExcelFile(filename) {
        if (!filename) return false;
        const ext = filename.split('.').pop().toLowerCase();
        return ext === 'xlsx' || ext === 'xls';
    }

    static async parseInput(input) {
        if (!input || input.trim().length === 0) return [];

        const cleaned = input.trim();
        const lines = cleaned.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) return [];

        // 1. Broker contract-note export (tab or comma header with Net Rate / Brokerage Per Share)
        const hasContractHeader = lines.slice(0, 15).some(l => this.isContractNoteExport(l));
        if (hasContractHeader) {
            const contractTrades = this.parseContractNoteTSV(cleaned);
            if (contractTrades.length > 0) return contractTrades;
        }

        // 2. Ledger lines: NSE/BSE ... D/T B/S qty price [bps] netRate
        const hasLedgerSignature = lines.some(l => /^(NSE|BSE)\s+\S+/i.test(l));
        if (hasLedgerSignature) {
            return this.parseLedgerFormat(cleaned);
        }

        // 3. Generic CSV/TSV with potential headers
        if (cleaned.includes('\t') || cleaned.includes(',')) {
            const trades = this.parseCSV(cleaned);
            if (trades.length > 0) return trades;
        }

        // 4. Fallback: Vertical block format (legacy)
        return this.parseVerticalBlocks(cleaned);
    }

    static isContractNoteExport(headerLine) {
        if (!headerLine) return false;
        const h = headerLine.toLowerCase();
        return (
            (h.includes('net rate') || h.includes('netrate')) &&
            (h.includes('brokerage per share') || h.includes('brokerage')) &&
            (h.includes('buy/sell') || h.includes('scrip') || h.includes('symbol'))
        );
    }

    static parseContractNoteTSV(text) {
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (lines.length < 2) return [];

        // Locate header line index
        let headerIdx = lines.findIndex(l => this.isContractNoteExport(l));
        if (headerIdx < 0) headerIdx = 0;

        const delimiter = lines[headerIdx].includes('\t') ? '\t' : ',';
        const headers = lines[headerIdx].split(delimiter).map(h => h.trim().toLowerCase());

        const colIdx = (candidates) =>
            headers.findIndex(h => candidates.some(c => h === c || h.includes(c)));

        const indices = {
            date: colIdx(['trade date', 'tradedate', 'date']),
            symbol: colIdx(['scrip symbol', 'scrip', 'symbol']),
            td: colIdx(['tdind', 'product', 'segment']),
            side: colIdx(['buy/sell', 'side', 'txn_type']),
            qty: colIdx(['quantity', 'qty']),
            price: colIdx(['rate', 'price', 'trade_price']),
            bps: colIdx(['brokerage per share', 'brokerage/share']),
            netRate: colIdx(['net rate', 'netrate']),
        };

        if (indices.symbol < 0 || indices.qty < 0 || indices.price < 0) return [];

        const parseNum = (val) => {
            if (val == null || val === '') return NaN;
            return parseFloat(String(val).replace(/,/g, ''));
        };

        const trades = [];

        for (let i = headerIdx + 1; i < lines.length; i++) {
            const cols = lines[i].split(delimiter).map(c => c.trim());
            if (cols.length < 5) continue;

            const symbol = cols[indices.symbol];
            if (!symbol || symbol.toLowerCase() === 'exchange') continue;

            const qty = parseNum(cols[indices.qty]);
            const price = parseNum(cols[indices.price]);
            if (isNaN(qty) || isNaN(price) || qty <= 0) continue;

            const sideRaw = indices.side > -1 ? cols[indices.side] : 'B';
            const isBuy = sideRaw.trim().toUpperCase().startsWith('B');

            let expenses = null;
            if (indices.bps > -1) {
                const bps = parseNum(cols[indices.bps]);
                if (!isNaN(bps) && bps >= 0.01) expenses = bps;
            }
            if (expenses == null && indices.netRate > -1) {
                const netRate = parseNum(cols[indices.netRate]);
                if (!isNaN(netRate)) {
                    const diff = isBuy ? netRate - price : price - netRate;
                    if (diff >= 0.01) expenses = diff;
                }
            }

            let orderType = 'MTF';
            if (indices.td > -1) {
                const td = cols[indices.td].trim().toUpperCase();
                if (td === 'T' || td === 'MIS' || td === 'INTRADAY' || td === 'DAY') orderType = 'MIS';
                else orderType = 'MTF';
            }

            trades.push({
                date: indices.date > -1 ? cols[indices.date] : new Date().toISOString(),
                symbol,
                side: isBuy ? 'BUY' : 'SELL',
                qty,
                price,
                expenses,
                orderType,
            });
        }

        return trades;
    }

    static parseCSV(text) {
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (lines.length < 2) return [];

        const map = CONFIG.columnMapping;

        // Find header index
        let headerIdx = lines.findIndex(l => {
            const lower = l.toLowerCase();
            return (lower.includes(',') || lower.includes('\t')) &&
                   map.symbol.some(s => lower.includes(s)) &&
                   map.qty.some(q => lower.includes(q));
        });
        if (headerIdx < 0) headerIdx = 0;

        const delimiter = lines[headerIdx].includes('\t') ? '\t' : ',';
        const headers = lines[headerIdx].split(delimiter).map(h => h.trim().toLowerCase());

        const getIdx = (candidates) => headers.findIndex(h => candidates.some(c => h.includes(c)));

        const indices = {
            date: getIdx(map.date),
            symbol: getIdx(map.symbol),
            side: getIdx(map.side),
            qty: getIdx(map.qty),
            price: getIdx(map.price),
            orderType: getIdx(map.orderType)
        };

        if (indices.symbol < 0 || indices.qty < 0 || indices.price < 0) return [];

        const parseNum = (val) => {
            if (val == null || val === '') return NaN;
            return parseFloat(String(val).replace(/,/g, ''));
        };

        const trades = [];
        for (let i = headerIdx + 1; i < lines.length; i++) {
            const cols = lines[i].split(delimiter).map(c => c.trim());
            if (cols.length < 4) continue;

            const symbol = indices.symbol > -1 ? cols[indices.symbol] : '';
            if (!symbol) continue;

            const qty = parseNum(cols[indices.qty]);
            const price = parseNum(cols[indices.price]);
            if (isNaN(qty) || isNaN(price) || qty <= 0) continue;

            let rawSide = indices.side > -1 ? cols[indices.side] : 'BUY';
            let isBuy = rawSide.trim().toUpperCase().startsWith('B');

            let orderType = 'MTF';
            if (indices.orderType > -1) {
                const rawOt = (cols[indices.orderType] || '').trim().toUpperCase();
                if (rawOt === 'T' || rawOt === 'MIS' || rawOt === 'INTRADAY' || rawOt === 'DAY') {
                    orderType = 'MIS';
                } else {
                    orderType = 'MTF';
                }
            }

            trades.push({
                date: indices.date > -1 ? cols[indices.date] : new Date().toISOString(),
                symbol: symbol.toUpperCase(),
                side: isBuy ? 'BUY' : 'SELL',
                qty,
                price,
                expenses: null,
                orderType
            });
        }
        return trades;
    }

    static parseLedgerFormat(text) {
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l);
        const trades = [];
        const pattern = /^(NSE|BSE)\s+(\S+)\s+(.+?)\s+([DT])\s+([BS])\s+([\d.,]+)\s+([\d.,]+)(?:\s+[\d.,]+)?\s+([\d.,]+)/i;

        for (const line of lines) {
            if (!line.startsWith('NSE') && !line.startsWith('BSE')) continue;

            const match = line.match(pattern);
            if (!match) continue;

            try {
                const exch = match[1];
                const date = match[2];
                const symbol = match[3].trim();
                const typeCode = match[4];
                const sideCode = match[5];
                const qty = parseFloat(match[6].replace(/,/g, ''));
                const price = parseFloat(match[7].replace(/,/g, ''));

                let netRate = price;
                if (match[8]) {
                    netRate = parseFloat(match[8].replace(/,/g, ''));
                    if (isNaN(netRate)) netRate = price;
                }

                let expenses = null;
                if (match[8]) {
                    if (sideCode === 'B') {
                        expenses = Math.max(0, netRate - price);
                    } else {
                        expenses = Math.max(0, price - netRate);
                    }
                    if (expenses < 0.01) expenses = null;
                }
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
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l);
        const trades = [];

        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            if (line === 'NSE' || line === 'BSE') {
                if (i + 6 < lines.length) {
                    try {
                        const date = lines[i + 1];
                        const symbol = lines[i + 2];
                        const typeCode = lines[i + 3];
                        const sideCode = lines[i + 4];
                        const qty = parseFloat(lines[i + 5]);
                        const price = parseFloat(lines[i + 6]);

                        let expenses = null;
                        let netPrice = price;
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
                            expenses: expenses,
                            orderType: typeCode === 'D' ? 'MTF' : 'MIS'
                        });

                        i += 7;
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

    static async fetchPrice(symbol, { marketOpen = false } = {}) {
        try {
            const ySymbol = `${symbol}.NS`;
            const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ySymbol}?interval=1d&range=1d`;
            const url = `https://api.allorigins.win/get?url=${encodeURIComponent(yUrl)}`;

            const response = await fetch(url);
            if (!response.ok) throw new Error("Network response was not ok");

            const proxyData = await response.json();
            const data = JSON.parse(proxyData.contents);

            if (!data.chart || !data.chart.result || data.chart.result.length === 0) {
                console.warn(`Yahoo API: No data for ${ySymbol}`);
                return null;
            }

            const meta = data.chart.result[0].meta;
            const currentPrice = meta.regularMarketPrice;
            const prevClose = meta.previousClose;

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