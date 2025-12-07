# MTF Position Tracker

A powerful, client-side web application designed to track **Margin Trading Facility (MTF)** positions for Indian stock market traders. It provides precise FIFO (First-In-First-Out) based P&L calculations, detailed charge estimation, and breakeven analysis.

## Key Features

*   **Realized P&L (Closed Positions)**:
    *   **Gross P&L**: Profit before interest (`Sell - Buy - Charges`).
    *   **Net P&L**: True profit in hand (`Gross P&L - Total Interest`).
    *   **Total Interest**: Explicit tracking of interest paid on closed legs.
    *   **Drill-Down**: Detailed view of every single buy/sell leg matched.
*   **Unrealized P&L (Open Positions)**:
    *   Live tracking with editable Current Market Price (CMP).
    *   Effective Average Price calculation including estimated buy charges.
*   **Detailed Charge Estimation**:
    *   Automatically calculates Brokerage (0.04%), STT (0.1%), Exchange Txn Charges, SEBI Charges, Stamp Duty, and GST (18%).
*   **Target Planning**:
    *   Breakeven calculation including interest accrued so far.
    *   Custom profit targets (1%, 2%, 5%, etc.) with a safe 0.5% buffer for future exit costs.
*   **Privacy Focused**: Runs 100% locally in your browser. No data is ever sent to a server.

## How to Run Locally

Since this is a static web application, you don't need to install any software or servers.

1.  Navigate to the project folder.
2.  Double-click `index.html` to open it in your web browser.
3.  That's it!

