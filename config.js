const CONFIG = {
    // Defaults based on standard Indian brokerage standard
    // Defaults based on details provided (Delivery 0.40%)
    brokerage: 0.004,       // 0.40%
    mtfInterestRate: 0.18,    // 18% p.a.
    sttSell: 0.001,           // 0.1% on sell value
    txnCharge: 0.0000325,     // 0.00325%
    sebiCharge: 0.000001,      // 0.0001% (₹10/crore)
    gst: 0.18,                // 18% on (brokerage + txn charges)
    stampDuty: 0.00015,       // 0.015% (standard delivery rate)

    // Profit targets to calculate
    profitTargets: [1, 2, 3, 5, 10], // Percentages

    // Mapping for user data (can be heuristic based)
    columnMapping: {
        date: ['date', 'trade_date', 'order_date', 'time'],
        symbol: ['symbol', 'scrip', 'stock', 'instrument'],
        qty: ['qty', 'quantity', 'volume'],
        price: ['price', 'rate', 'avg_price', 'trade_price'],
        side: ['side', 'buy/sell', 'type', 'txn_type'],
        orderType: ['order_type', 'product', 'product_type']
    }
};

// State handling for the application
window.APP_STATE = {
    trades: [],
    positions: [],
    processedData: null
};
