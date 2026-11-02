const {total}=require('./money.cjs');
exports.calcInvoice=(lines,rate)=>total(lines)+rate;
