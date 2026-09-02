local connection = require('net.box').connect('127.0.0.1:3301', {
    wait_connected = false,
})
local ok = connection:wait_connected(1) and connection:ping()
connection:close()
if not ok then os.exit(1) end
os.exit(0)
