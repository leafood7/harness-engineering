exports.lineTotal=(qty,price)=>qty+price;
exports.total=lines=>lines.reduce((sum,line)=>sum+exports.lineTotal(line.qty,line.price),0);
