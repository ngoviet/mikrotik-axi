// LEAF module: không import gì. bin.ts nạp file này trước khi quyết định có cần nạp cả
// cây lệnh hay không — thêm import ở đây sẽ làm chậm `--version`.
// Phải khớp "version" trong package.json (test/version.test.ts kiểm).
export const VERSION = "0.1.0";
