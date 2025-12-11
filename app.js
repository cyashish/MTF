// Main Application Controller

const APP = {
    init() {
        console.log('MTF Tracker Initialized');

        // Event Listeners
        document.getElementById('btnProcess').addEventListener('click', this.handleProcess.bind(this));

        // Create global access for inline onclicks
        window.APP = this;

        // Sorting State
        this.sortState = {
            open: { key: 'symbol', dir: 'asc' }, // Options: symbol, interestAmount, daysHeld
            closed: { key: 'symbol', dir: 'asc' }, // Options: symbol, totalInterest, realizedPnL
            unrealized: { key: 'symbol', dir: 'asc' } // Options: symbol
        };
    },

    toggleSort(type, key) {
        const current = this.sortState[type];
        if (current.key === key) {
            // Toggle direction
            current.dir = current.dir === 'asc' ? 'desc' : 'asc';
        } else {
            current.key = key;
            current.dir = 'asc';
        }

        // Trigger re-render with current data
        if (window.APP_STATE && window.APP_STATE.positions) {
            const customTarget = parseFloat(document.getElementById('customTarget')?.value || 10);
            this.renderDashboard(window.APP_STATE.positions, window.APP_STATE.closedPositions, customTarget);
        }
    },

    // Helper to sort list
    sortList(list, type) {
        const { key, dir } = this.sortState[type];
        if (!list || list.length === 0) return [];

        return [...list].sort((a, b) => {
            let valA = a[key];
            let valB = b[key];

            // String comparison
            if (typeof valA === 'string') {
                return dir === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
            }
            // Numeric comparison
            return dir === 'asc' ? valA - valB : valB - valA;
        });
    },

    setUnrealizedUpdatedAt(ts = new Date()) {
        window.APP_STATE.unrealizedUpdatedAt = ts;
        this.updateUnrealizedTimestampLabel();
    },

    updateUnrealizedTimestampLabel() {
        const label = document.getElementById('unrealizedUpdatedAt');
        if (!label) return;

        const ts = window.APP_STATE.unrealizedUpdatedAt || window.APP_STATE.priceMeta?.updatedAt;
        if (!ts) {
            label.textContent = '';
            return;
        }

        const tz = CONFIG.marketHours.timezone || 'Asia/Kolkata';
        const nowIst = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
        const updatedIst = new Date(new Date(ts).toLocaleString('en-US', { timeZone: tz }));

        const dateStr = updatedIst.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        const timeStr = updatedIst.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        // Compare only the date part in IST
        const today = new Date(nowIst.getFullYear(), nowIst.getMonth(), nowIst.getDate());
        const updatedDay = new Date(updatedIst.getFullYear(), updatedIst.getMonth(), updatedIst.getDate());
        const diffDays = Math.floor((today - updatedDay) / (1000 * 60 * 60 * 24));

        const closeMinutes = (CONFIG.marketHours.closeHour * 60) + CONFIG.marketHours.closeMinute;
        const nowMinutes = (nowIst.getHours() * 60) + nowIst.getMinutes();

        let statusNote = '';
        if (diffDays >= 1) {
            statusNote = ' — market yet to open';
        } else if (nowMinutes >= closeMinutes) {
            statusNote = ' — markets closed';
        }

        label.textContent = `Last updated ${dateStr} at ${timeStr} IST${statusNote}`;
    },

    isMarketOpen(now = new Date()) {
        const { marketHours } = CONFIG;
        const istNow = new Date(now.toLocaleString('en-US', { timeZone: marketHours.timezone || 'Asia/Kolkata' }));
        const day = istNow.getDay(); // 0 = Sun

        if (!marketHours.workingDays.includes(day)) {
            return { isOpen: false, reason: 'Market closed (weekend/holiday)' };
        }

        const minutes = istNow.getHours() * 60 + istNow.getMinutes();
        const openMinutes = (marketHours.openHour * 60) + marketHours.openMinute;
        const closeMinutes = (marketHours.closeHour * 60) + marketHours.closeMinute;

        const isOpen = minutes >= openMinutes && minutes <= closeMinutes;
        return { isOpen, reason: isOpen ? 'Market open' : 'Market closed (outside hours)' };
    },

    startPolling() {
        // Clear previous interval
        if (this.pollingInterval) clearInterval(this.pollingInterval);

        const poll = async () => {
            if (!window.APP_STATE.positions || window.APP_STATE.positions.length === 0) return;
            const market = this.isMarketOpen();
            await this.fetchAllPrices(market);
        };

        // Initial fetch
        poll();

        // Schedule
        this.pollingInterval = setInterval(poll, CONFIG.pricePollIntervalMs || 3600000);
    },

    async handleProcess() {
        const input = document.getElementById('pasteInput').value;
        const btn = document.getElementById('btnProcess');
        const spinner = document.getElementById('loadingSpinner');
        const status = document.getElementById('statusMsg');

        if (!input.trim()) {
            status.innerHTML = '<span class="negative">Please paste some data first.</span>';
            return;
        }

        // UI Loading State
        btn.disabled = true;
        spinner.classList.remove('hidden');
        status.textContent = 'Parsing...';

        try {
            // 1. Parse
            const rawTrades = await DataHandler.parseInput(input);
            console.log('Parsed trades:', rawTrades.length);

            if (rawTrades.length === 0) {
                throw new Error("No valid trades found. Check format.");
            }

            // 2. Calculate
            status.textContent = 'Calculating positions...';
            // Small delay to allow UI to update
            await new Promise(r => setTimeout(r, 50));

            window.APP_STATE.rawTrades = rawTrades; // Save for recalculation

            // Default calculation (100% funding, 0 delay) unless changed
            const { openPositions, closedPositions } = Calculator.processTrades(rawTrades);
            window.APP_STATE.positions = openPositions;
            window.APP_STATE.closedPositions = closedPositions;

            // 3. Render
            this.renderDashboard(openPositions, closedPositions);

            const totalPos = openPositions.length;
            const closedCount = closedPositions.length;
            status.innerHTML = `<span class="positive">Processed ${rawTrades.length} trades. Open: ${totalPos}, Closed: ${closedCount}.</span>`;

            // Start Live Price Polling
            this.startPolling();

        } catch (e) {
            console.error(e);
            status.innerHTML = `<span class="negative">Error: ${e.message}</span>`;
        } finally {
            btn.disabled = false;
            spinner.classList.add('hidden');
        }
    },

    // Live Price Polling
    async fetchAllPrices(marketStatus = { isOpen: false, reason: '' }) {
        if (!window.APP_STATE.positions) return;

        console.log("Fetching live prices...");
        const status = document.getElementById('statusMsg');
        const originalText = status.textContent;
        status.textContent = marketStatus.isOpen ? "Fetching live prices..." : "Fetching last close prices...";

        let updatedCount = 0;
        let lastSource = '';

        // Use a map to store prices to avoid refetching same symbol multiple times
        const priceMap = new Map();

        // Unique symbols
        const symbols = [...new Set(window.APP_STATE.positions.map(p => p.symbol))];

        for (const sym of symbols) {
            const res = await DataHandler.fetchPrice(sym, { marketOpen: marketStatus.isOpen });
            if (res && res.price !== null && res.price > 0) {
                priceMap.set(sym, res.price);
                lastSource = res.source || lastSource;
                updatedCount++;
            }
        }

        // Update positions with new price
        window.APP_STATE.positions.forEach((pos, idx) => {
            if (priceMap.has(pos.symbol)) {
                // Determine which Input ID this position corresponds to in the rendered table
                // Note: The table rendering might change order if sorted.
                // Best approach: Add 'currentPrice' to position object and re-render OR update DOM.
                // Updating DOM is smoother if user is typing, but re-render is safer for consistency.
                pos.currentPrice = priceMap.get(pos.symbol);
                pos.priceSource = lastSource || 'unknown';
            }
        });

        if (updatedCount > 0) {
            console.log(`Updated prices for ${updatedCount} symbols.`);
            const ts = new Date();
            window.APP_STATE.priceMeta = {
                updatedAt: ts,
                marketOpen: marketStatus.isOpen,
                source: lastSource || (marketStatus.isOpen ? 'regularMarketPrice' : 'previousClose')
            };
            this.setUnrealizedUpdatedAt(ts);
            const tsStr = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            status.textContent = `Updated prices (${lastSource || 'auto'}).`;

            // Update price meta banner
            const metaEl = document.getElementById('priceMeta');
            if (metaEl) {
                metaEl.textContent = `Prices updated at ${tsStr} (IST) using ${window.APP_STATE.priceMeta.source} — ${marketStatus.isOpen ? 'Market open' : 'Market closed'}`;
            }

            // Re-render (preserving sort)
            this.renderDashboard(window.APP_STATE.positions, window.APP_STATE.closedPositions, document.getElementById('customTarget')?.value || 10);

            setTimeout(() => {
                status.textContent = originalText;
            }, 3000);
        } else {
            status.textContent = originalText; // revert silently if nothing found
        }
    },

    recalculate() {
        if (!window.APP_STATE.rawTrades) return;

        // Grab config from UI
        const fundingInput = document.getElementById('fundingRatio');
        const delayInput = document.getElementById('interestDelay');
        const customTargetInput = document.getElementById('customTarget');

        let fundedRatio = fundingInput ? parseFloat(fundingInput.value) : 1.0;
        if (isNaN(fundedRatio)) fundedRatio = 1.0;

        let interestDelay = delayInput ? parseInt(delayInput.value) : 0;
        if (isNaN(interestDelay)) interestDelay = 0;

        let customTarget = customTargetInput ? parseFloat(customTargetInput.value) : 10;
        if (isNaN(customTarget)) customTarget = 10;

        const configOverrides = {
            fundedRatio,
            interestDelay,
            customTarget
        };

        const { openPositions, closedPositions } = Calculator.processTrades(window.APP_STATE.rawTrades, configOverrides);

        // PRESERVE Fetched Prices if they exist in old state
        if (window.APP_STATE.positions) {
            openPositions.forEach(newPos => {
                const oldPos = window.APP_STATE.positions.find(p => p.symbol === newPos.symbol);
                if (oldPos) {
                    if (oldPos.currentPrice) {
                        newPos.currentPrice = oldPos.currentPrice;
                    }
                    if (oldPos.priceSource) {
                        newPos.priceSource = oldPos.priceSource;
                    }
                }
            });
        }

        window.APP_STATE.positions = openPositions;
        window.APP_STATE.closedPositions = closedPositions;

        // Pass custom target to renderer
        this.renderDashboard(openPositions, closedPositions, customTarget);
    },

    renderDashboard(openPositions, closedPositions, customTarget = 10) {
        document.getElementById('dashboard').classList.remove('hidden');

        // Price meta banner
        const priceMetaEl = document.getElementById('priceMeta');
        if (priceMetaEl) {
            const meta = window.APP_STATE.priceMeta;
            if (meta && meta.updatedAt) {
                const tsStr = meta.updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                priceMetaEl.textContent = `Prices updated at ${tsStr} (IST) using ${meta.source || 'auto'} — ${meta.marketOpen ? 'Market open' : 'Market closed'}`;
            } else {
                priceMetaEl.textContent = '';
            }
        }

        // Apply Sorting
        const sortedOpen = this.sortList(openPositions, 'open');
        const sortedClosed = this.sortList(closedPositions, 'closed');
        const sortedUnrealized = this.sortList(openPositions, 'unrealized');

        // Render Summary (Open Positions)
        const summaryHtml = Components.renderSummary(openPositions); // Summary uses totals, order doesn't matter
        document.getElementById('summaryContainer').innerHTML = summaryHtml;

        // Render Table (Open Positions)
        Components.renderTable(sortedOpen, 'tableContainer', customTarget, this.sortState.open);

        // Render Closed Positions Table (Safe check if container exists)
        if (closedPositions && document.getElementById('closedTableContainer')) {
            Components.renderClosedTable(sortedClosed, 'closedTableContainer', this.sortState.closed);
        }

        // Render Unrealized P&L Table (Open Positions)
        const showUnrealized = document.getElementById('showUnrealized').checked;
        const unrealizedContainer = document.getElementById('unrealizedTableContainer');

        if (unrealizedContainer) {
            if (showUnrealized) {
                unrealizedContainer.parentElement.classList.remove('hidden');
                Components.renderUnrealizedTable(sortedUnrealized, 'unrealizedTableContainer', this.sortState.unrealized);
                this.updateUnrealizedTimestampLabel();
            } else {
                unrealizedContainer.parentElement.classList.add('hidden');
                unrealizedContainer.innerHTML = ''; // a cleanup
            }
        }
    },

    copyRow(symbol, qty, price) {
        // Format: EXCH, SYMBOL, SELL, QTY, PRICE, PRODUCT
        // Price is Breakeven Price
        const text = `NSE,${symbol},SELL,${qty},${price},MTF`;

        navigator.clipboard.writeText(text).then(() => {
            console.log('Copied:', text);
        }).catch(err => {
            console.error('Failed to copy', err);
        });
    },

    copyAll() {
        const positions = window.APP_STATE.positions;
        if (!positions || positions.length === 0) return;

        const lines = positions.map(p => {
            return `NSE,${p.symbol},SELL,${p.qty},${p.breakevenPrice.toFixed(2)},MTF`;
        });

        const text = lines.join('\n');

        navigator.clipboard.writeText(text).then(() => {
            alert(`Copied ${lines.length} sell orders to clipboard!`);
        });
    }
};

// Start the app
document.addEventListener('DOMContentLoaded', () => APP.init());
