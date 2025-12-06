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

## How to Distribute / Host for Free

You can host this application for free using static hosting providers. Here are the two recommended methods:

### Option 1: Netlify Drop (Easiest & Fastest)
Ideal for quick sharing without creating accounts or repositories.

1.  Go to [app.netlify.com/drop](https://app.netlify.com/drop).
2.  Open your file explorer on your computer.
3.  Drag and drop the **entire project folder** (containing `index.html`) onto the Netlify page.
4.  Wait a few seconds for it to upload.
5.  **Done!** Netlify will give you a live URL (e.g., `https://random-name.netlify.app`) that you can share with anyone.

### Option 2: GitHub Pages (Recommended for Updates)
Ideal if you want a permanent link and plan to update the code later.

1.  Create a new public repository on [GitHub](https://github.com/new).
2.  Upload all the project files (`index.html`, `*.js`, `*.css`) to the repository.
3.  Go to the repository **Settings** tab.
4.  Scroll down to the **Pages** section (or click "Pages" in the left sidebar).
5.  Under **Build and deployment**, select **Source** as `Deploy from a branch`.
6.  Under **Branch**, select `main` (or `master`) and folder `/ (root)`, then click **Save**.
7.  Wait a minute or two. GitHub will provide your live site URL (e.g., `https://yourusername.github.io/repo-name/`).
