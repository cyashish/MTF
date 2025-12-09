class Components {
    static formatCurrency(num) {
        return new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            minimumFractionDigits: 2
        }).format(num);
    }

    static formatDate(dateObj) {
        return dateObj.toLocaleDateString('en-GB'); // DD/MM/YYYY
    }

    static renderTable(positions, containerId, customTarget = 10, sortConfig = null) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (positions.length === 0) {
            container.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-secondary);">No open positions found.</div>';
            return;
        }

        const getSortArrow = (key) => {
            if (!sortConfig || sortConfig.key !== key) return '';
            return sortConfig.dir === 'asc' ? ' ▲' : ' ▼';
        };

        let html = `
            <table>
                <thead>
                    <tr>
                        <th style="width: 250px; cursor: pointer; user-select: none;" onclick="APP.toggleSort('open', 'symbol')">Symbol${getSortArrow('symbol')}</th>
                        <th class="num">Qty</th>
                        <th class="num">Avg Buy</th>
                        <th class="num" style="cursor: pointer; user-select: none;" onclick="APP.toggleSort('open', 'interestAmount')">Interest${getSortArrow('interestAmount')}</th>
                        <th class="num" style="cursor: pointer; user-select: none;" onclick="APP.toggleSort('open', 'daysHeld')">Days${getSortArrow('daysHeld')}</th>
                        <th class="num" style="color: var(--warning)">Breakeven</th>
                        <th class="num" style="color: var(--success)">Target 1%</th>
                        <th class="num" style="color: var(--success)">Target 2%</th>
                        <th class="num" style="color: var(--success)">Target 5%</th>
                        <th class="num" style="color: var(--accent-primary)">Target ${customTarget}%</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>
        `;

        positions.forEach((pos, idx) => {
            // Check if we have legs (should always have at least 1)
            const hasLegs = pos.legs && pos.legs.length > 0;
            const drillId = `drill-${idx}`;

            // Toggle Button - Always show if we have leg data
            const toggleBtn = hasLegs
                ? `<span style="display:inline-block; width:20px; text-align:center; cursor:pointer; font-weight:bold; color:var(--accent-primary); margin-right:5px; user-select:none; font-size:1.2em;" 
                         onclick="document.getElementById('${drillId}').classList.toggle('hidden'); this.textContent = this.textContent === '+' ? '-' : '+'">+</span>`
                : `<span style="display:inline-block; width:20px; margin-right:5px;"></span>`;

            // Symbol Cell content
            const symbolContent = `
                <div style="display:flex; align-items:center;">
                    ${toggleBtn}
                    <span>${pos.symbol}</span>
                    <span style="font-size:0.7em; opacity:0.6; margin-left:8px; align-self:center;">(${pos.legs.length})</span>
                </div>
            `;

            // Safe access targets
            const target5 = pos.targets[5] ? pos.targets[5].toFixed(2) : '-';
            const targetCustom = pos.targets[customTarget] ? pos.targets[customTarget].toFixed(2) : '-';

            html += `
                <tr>
                    <td style="font-weight: 600;">${symbolContent}</td>
                    <td class="num">${pos.qty}</td>
                    <td class="num">${pos.avgPrice.toFixed(2)}</td>
                    <td class="num" style="color: var(--warning)">${this.formatCurrency(pos.interestAmount)}</td>
                    <td class="num" title="Buy Date: ${pos.buyDate.toLocaleDateString()}">${pos.daysHeld}</td>
                    <td class="num" style="color: var(--warning); font-weight: bold;">${pos.breakevenPrice.toFixed(2)}</td>
                    <td class="num" style="color: var(--success);">${pos.targets[1].toFixed(2)}</td>
                    <td class="num" style="color: var(--success); opacity: 0.8;">${pos.targets[2].toFixed(2)}</td>
                    <td class="num" style="color: var(--success); font-weight:bold;">${target5}</td>
                    <td class="num" style="color: var(--accent-primary); font-weight:bold;">${targetCustom}</td>
                    <td>
                        <button class="btn-icon" onclick="APP.copyRow('${pos.symbol}', ${pos.qty}, ${pos.breakevenPrice.toFixed(2)})" title="Copy Sell Order">
                            📋
                        </button>
                    </td>
                </tr>
            `;

            // Drill Down Detail Row
            if (hasLegs) {
                let legsHtml = `
                    <tr id="${drillId}" class="hidden" style="background-color: rgba(255, 255, 255, 0.03);">
                        <td colspan="10" style="padding: 0;">
                            <div style="padding: 0.5rem 0.5rem 0.5rem 3.5rem; border-left: 2px solid var(--accent-primary);">
                                <table style="width: 100%; font-size: 0.8rem; opacity: 0.9;">
                                    <thead>
                                        <tr style="border-bottom: 1px solid var(--border-color);">
                                            <th style="background:transparent; padding:0.4rem; text-align:left; color:var(--text-secondary);">Date</th>
                                            <th style="background:transparent; padding:0.4rem; text-align:right; color:var(--text-secondary);">Qty</th>
                                            <th style="background:transparent; padding:0.4rem; text-align:right; color:var(--text-secondary);">Price</th>
                                            <th style="background:transparent; padding:0.4rem; text-align:right; color:var(--text-secondary);">Days</th>
                                            <th style="background:transparent; padding:0.4rem; text-align:right; color:var(--text-secondary);">Interest</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                `;

                // Sort legs by date (oldest first)
                const sortedLegs = [...pos.legs].sort((a, b) => a.date - b.date);

                sortedLegs.forEach(leg => {
                    legsHtml += `
                        <tr style="border:none;">
                            <td style="padding:0.3rem 0.4rem; border:none;" title="Raw Date: ${leg.rawDate || 'N/A'}">${this.formatDate(leg.date)} <span style="font-size:0.8em; opacity:0.5; cursor:help">ℹ️</span></td>
                            <td style="padding:0.3rem 0.4rem; text-align:right; border:none;">${leg.qty}</td>
                            <td style="padding:0.3rem 0.4rem; text-align:right; border:none;">${leg.price.toFixed(2)}</td>
                            <td style="padding:0.3rem 0.4rem; text-align:right; border:none;">${leg.days}</td>
                            <td style="padding:0.3rem 0.4rem; text-align:right; color: var(--warning); border:none;">${this.formatCurrency(leg.interest)}</td>
                        </tr>
                    `;
                });

                legsHtml += `</tbody></table></div></td></tr>`;
                html += legsHtml;
            }
        });

        html += '</tbody></table>';
        container.innerHTML = html;
    }

    static renderSummary(positions) {
        const totalCapital = positions.reduce((sum, p) => sum + (p.qty * p.avgPrice), 0);
        const totalInterest = positions.reduce((sum, p) => sum + p.interestAmount, 0);
        const totalDailyInterest = positions.reduce((sum, p) => sum + (p.dailyInterest || 0), 0);

        return `
            <div class="grid">
                <div class="card" style="padding: 1rem;">
                    <div class="text-sm text-muted">Open Positions</div>
                    <div class="card-title">${positions.length}</div>
                </div>
                <div class="card" style="padding: 1rem;">
                    <div class="text-sm text-muted">Capital Deployed</div>
                    <div class="card-title">${this.formatCurrency(totalCapital)}</div>
                </div>
                <div class="card" style="padding: 1rem;">
                    <div class="text-sm text-muted">Interest Accrued</div>
                    <div class="card-title" style="color: var(--warning)">${this.formatCurrency(totalInterest)}</div>
                </div>
                <div class="card" style="padding: 1rem;">
                    <div class="text-sm text-muted">Daily Interest</div>
                    <div class="card-title" style="color: var(--warning); opacity: 0.8;">${this.formatCurrency(totalDailyInterest)}</div>
                </div>
            </div>
        `;
    }

    static renderClosedTable(positions, containerId, sortConfig = null) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (positions.length === 0) {
            container.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-secondary);">No closed positions found yet.</div>';
            return;
        }

        const getSortArrow = (key) => {
            if (!sortConfig || sortConfig.key !== key) return '';
            return sortConfig.dir === 'asc' ? ' ▲' : ' ▼';
        };

        // Calculate Total P&L
        // Calculate Total P&L and Interest
        const totalGrossPnL = positions.reduce((sum, p) => sum + (p.grossPnL || 0), 0);
        const totalPnL = positions.reduce((sum, p) => sum + p.realizedPnL, 0);
        const totalInterest = positions.reduce((sum, p) => sum + (p.totalInterest || 0), 0);

        const totalPnLColor = totalPnL >= 0 ? 'var(--success)' : 'var(--warning)';
        const totalGrossColor = totalGrossPnL >= 0 ? 'var(--success)' : 'var(--warning)';

        let html = `
            <table>
                <thead>
                    <tr>
                        <th style="width: 250px; cursor: pointer; user-select: none;" onclick="APP.toggleSort('closed', 'symbol')">Symbol${getSortArrow('symbol')}</th>
                        <th class="num">Closed Qty</th>
                        <th class="num">Gross P&L</th>
                        <th class="num" style="cursor: pointer; user-select: none;" onclick="APP.toggleSort('closed', 'totalInterest')">Total Interest${getSortArrow('totalInterest')}</th>
                        <th class="num" style="cursor: pointer; user-select: none;" onclick="APP.toggleSort('closed', 'realizedPnL')">Net P&L${getSortArrow('realizedPnL')}</th>
                    </tr>
                </thead>
                <tbody>
                    <!-- Total Row -->
                    <tr style="background-color: rgba(255,255,255,0.05); font-weight: bold; border-bottom: 2px solid var(--border-color);">
                        <td style="padding: 1rem 0.5rem; text-transform: uppercase; letter-spacing: 0.05em;">Total Realized P&L</td>
                        <td></td>
                        <td class="num" style="color: ${totalGrossColor};">${this.formatCurrency(totalGrossPnL)}</td>
                        <td class="num" style="color: var(--warning);">${this.formatCurrency(totalInterest)}</td>
                        <td class="num" style="color: ${totalPnLColor}; font-size: 1.1em;">${this.formatCurrency(totalPnL)}</td>
                    </tr>
        `;

        positions.forEach((pos, idx) => {
            const drillId = `closed-drill-${idx}`;

            // Toggle Button
            const toggleBtn = `<span style="display:inline-block; width:20px; text-align:center; cursor:pointer; font-weight:bold; color:var(--accent-primary); margin-right:5px; user-select:none; font-size:1.2em;" 
                         onclick="document.getElementById('${drillId}').classList.toggle('hidden'); this.textContent = this.textContent === '+' ? '-' : '+'">+</span>`;

            const pnlColor = pos.realizedPnL >= 0 ? 'var(--success)' : 'var(--warning)';
            const grossColor = (pos.grossPnL || 0) >= 0 ? 'var(--success)' : 'var(--warning)';

            html += `
                <tr>
                    <td style="font-weight: 600;">
                        <div style="display:flex; align-items:center;">
                            ${toggleBtn}
                            <span>${pos.symbol}</span>
                            <span style="font-size:0.7em; opacity:0.6; margin-left:8px; align-self:center;">(${pos.legs.length} trades)</span>
                        </div>
                    </td>
                    <td class="num">${pos.qty}</td>
                    <td class="num" style="color: ${grossColor};">${this.formatCurrency(pos.grossPnL || 0)}</td>
                    <td class="num" style="color: var(--warning);">${this.formatCurrency(pos.totalInterest || 0)}</td>
                    <td class="num" style="color: ${pnlColor}; font-weight:bold;">${this.formatCurrency(pos.realizedPnL)}</td>
                </tr>
            `;

            // Drill Down row
            let legsHtml = `
                <tr id="${drillId}" class="hidden" style="background-color: rgba(255, 255, 255, 0.03);">
                    <td colspan="5" style="padding: 0;">
                        <div style="padding: 0.5rem 0.5rem 0.5rem 3.5rem; border-left: 2px solid var(--accent-primary);">
                            <table style="width: 100%; font-size: 0.8rem; opacity: 0.9;">
                                <thead>
                                    <tr style="border-bottom: 1px solid var(--border-color);">
                                        <th style="background:transparent; padding:0.4rem; text-align:left; color:var(--text-secondary);">Buy Date</th>
                                        <th style="background:transparent; padding:0.4rem; text-align:left; color:var(--text-secondary);">Sell Date</th>
                                        <th style="background:transparent; padding:0.4rem; text-align:right; color:var(--text-secondary);">Qty</th>
                                        <th style="background:transparent; padding:0.4rem; text-align:right; color:var(--text-secondary);">Buy Price</th>
                                        <th style="background:transparent; padding:0.4rem; text-align:right; color:var(--text-secondary);">Sell Price</th>
                                        <th style="background:transparent; padding:0.4rem; text-align:right; color:var(--text-secondary);">Gross P&L</th>
                                        <th style="background:transparent; padding:0.4rem; text-align:right; color:var(--text-secondary);">Interest</th>
                                        <th style="background:transparent; padding:0.4rem; text-align:right; color:var(--text-secondary);">Net P&L</th>
                                    </tr>
                                </thead>
                                <tbody>
            `;

            pos.legs.forEach(leg => {
                const legPnlColor = leg.pnl >= 0 ? 'var(--success)' : 'var(--warning)';
                const legGrossColor = (leg.grossPnl || 0) >= 0 ? 'var(--success)' : 'var(--warning)';

                legsHtml += `
                    <tr style="border:none;">
                        <td style="padding:0.3rem 0.4rem; border:none;">${this.formatDate(leg.buyDate)}</td>
                        <td style="padding:0.3rem 0.4rem; border:none;">${this.formatDate(leg.sellDate)}</td>
                        <td style="padding:0.3rem 0.4rem; text-align:right; border:none;">${leg.qty}</td>
                        <td style="padding:0.3rem 0.4rem; text-align:right; border:none;">${leg.buyPrice.toFixed(2)}</td>
                        <td style="padding:0.3rem 0.4rem; text-align:right; border:none;">${leg.sellPrice.toFixed(2)}</td>
                        <td style="padding:0.3rem 0.4rem; text-align:right; color: ${legGrossColor}; border:none;">${this.formatCurrency(leg.grossPnl || 0)}</td>
                        <td style="padding:0.3rem 0.4rem; text-align:right; color: var(--warning); border:none;">${this.formatCurrency(leg.interest || 0)}</td>
                        <td style="padding:0.3rem 0.4rem; text-align:right; color: ${legPnlColor}; border:none;">${this.formatCurrency(leg.pnl)}</td>
                    </tr>
                 `;
            });

            legsHtml += `</tbody></table></div></td></tr>`;
            html += legsHtml;
        });

        html += '</tbody></table>';
        container.innerHTML = html;
    }

    static renderUnrealizedTable(positions, containerId, sortConfig = null) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (positions.length === 0) {
            container.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-secondary);">No open positions to track.</div>';
            return;
        }

        const getSortArrow = (key) => {
            if (!sortConfig || sortConfig.key !== key) return '';
            return sortConfig.dir === 'asc' ? ' ▲' : ' ▼';
        };

        // Attach global handler for updating calculations
        window.APP.updateUnrealized = (idx, qty, avgPrice) => {
            const input = document.getElementById(`ltp-${idx}`);
            const pnlCell = document.getElementById(`pnl-${idx}`);
            const ltp = parseFloat(input.value);

            if (isNaN(ltp) || ltp <= 0) {
                pnlCell.textContent = '-';
                pnlCell.style.color = 'var(--text-secondary)';
                pnlCell.dataset.val = 0;
            } else {
                // P&L = (LTP - AvgPrice) * Qty
                const pnl = (ltp - avgPrice) * qty;
                pnlCell.textContent = this.formatCurrency(pnl);
                pnlCell.style.color = pnl >= 0 ? 'var(--success)' : 'var(--warning)';

                // Store Pnl in dataset for Total Calculation
                pnlCell.dataset.val = pnl;
            }
            Components.updateUnrealizedTotal();
        };

        let html = `
            <table>
                <thead>
                    <tr>
                        <th style="width: 250px; cursor: pointer; user-select: none;" onclick="APP.toggleSort('unrealized', 'symbol')">Symbol${getSortArrow('symbol')}</th>
                        <th class="num">Qty</th>
                        <th class="num">Avg Buy</th>
                        <th class="num" style="width: 150px;">Current Price (LTP)</th>
                        <th class="num">Unrealized P&L</th>
                    </tr>
                </thead>
                <tbody>
                    <!-- Total Row -->
                    <tr style="background-color: rgba(255,255,255,0.05); font-weight: bold; border-bottom: 2px solid var(--border-color);">
                        <td style="padding: 1rem 0.5rem; text-transform: uppercase; letter-spacing: 0.05em;">Total Unrealized P&L</td>
                        <td></td>
                        <td></td>
                        <td></td>
                        <td id="totalUnrealizedPnL" class="num" style="font-size: 1.1em;">-</td>
                    </tr>
        `;

        positions.forEach((pos, idx) => {
            html += `
                <tr>
                    <td style="font-weight: 600;">${pos.symbol}</td>
                    <td class="num">${pos.qty}</td>
                    <td class="num">${pos.avgPrice.toFixed(2)}</td>
                    <td class="num">
                        <input type="number" id="ltp-${idx}" placeholder="Enter Price" 
                            style="width: 100px; padding: 0.5rem; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-dark); color: white; text-align: right;"
                            oninput="window.APP.updateUnrealized(${idx}, ${pos.qty}, ${pos.avgPrice})"
                        >
                    </td>
                    <td id="pnl-${idx}" class="num" data-val="0" style="font-weight:bold;">-</td>
                </tr>
            `;
        });

        html += '</tbody></table>';
        container.innerHTML = html;
    }

    static updateUnrealizedTotal() {
        // Sum up all data-val attributes
        const cells = document.querySelectorAll('[id^="pnl-"]');
        let total = 0;
        let hasData = false;

        cells.forEach(cell => {
            const val = parseFloat(cell.dataset.val);
            if (!isNaN(val) && val !== 0) { // Only count if calculated
                total += val;
                hasData = true;
            }
        });

        const totalCell = document.getElementById('totalUnrealizedPnL');
        if (hasData) {
            totalCell.textContent = this.formatCurrency(total);
            totalCell.style.color = total >= 0 ? 'var(--success)' : 'var(--warning)';
        } else {
            totalCell.textContent = '-';
            totalCell.style.color = 'inherit';
        }
    }
}
