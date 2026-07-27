const fs = require('fs');
let code = fs.readFileSync('src/__tests__/tools.test.ts', 'utf8');

// Replace candela_session_cost with candela_cost_summary
code = code.replace(/candela_session_cost\.execute\(/g, 'candela_cost_summary.execute({ scope: "session" }, ');
code = code.replace(/candela_session_cost\.execute\(\{\},/g, 'candela_cost_summary.execute({ scope: "session" },');
code = code.replace(/describe\("candela_session_cost",/g, 'describe("candela_cost_summary (session)",');

// Replace candela_inspect_trace with candela_traces
code = code.replace(/candela_inspect_trace\.execute\(/g, 'candela_traces.execute(');
code = code.replace(/describe\("candela_inspect_trace",/g, 'describe("candela_traces (inspect)",');

// Also candela_list_traces -> candela_traces
code = code.replace(/candela_list_traces\.execute\(/g, 'candela_traces.execute(');
code = code.replace(/describe\("candela_list_traces",/g, 'describe("candela_traces (list)",');

fs.writeFileSync('src/__tests__/tools.test.ts', code);
