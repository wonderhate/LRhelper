local LrFileUtils = import 'LrFileUtils'
local LrPathUtils = import 'LrPathUtils'
local LrHttp = import 'LrHttp'
local JSON = require 'JSON'

local Client = {}

function Client.config()
    local home = LrPathUtils.getStandardFilePath('home')
    local file = LrPathUtils.child(home, '.config/lr-codex-studio/host.json')
    if not LrFileUtils.exists(file) then
        error('Studio Host 未运行。请先运行项目 scripts/start-studio-host.ps1，再点击读取照片。', 0)
    end
    local config = JSON:decode(LrFileUtils.readFile(file))
    if config.version ~= 1 or type(config.url) ~= 'string'
        or not config.url:match('^http://127%.0%.0%.1:%d+$')
        or type(config.token) ~= 'string' or #config.token ~= 64 then
        error('Host 连接记录无效，请重新启动 Studio Host。', 0)
    end
    return config
end

function Client.request(method, route, data)
    local config = Client.config()
    local headers = {
        { field = 'X-Studio-Token', value = config.token },
        { field = 'Content-Type', value = 'application/json' },
    }
    local body, response
    if method == 'GET' then
        body, response = LrHttp.get(config.url .. route, headers, 8)
    else
        body, response = LrHttp.post(config.url .. route, JSON:encode(data or {}), headers, 'POST', 8)
    end
    if not body or body == '' then
        error('无法连接 Studio Host，请检查 Host 是否运行，然后重试。', 0)
    end
    local decoded = JSON:decode(body)
    if response and response.status and response.status >= 400 then
        error(decoded.error or 'Studio Host 请求失败', 0)
    end
    local isJob = type(decoded.id) == 'string' and type(decoded.status) == 'string' and type(decoded.photoId) == 'string'
    if decoded.error and not decoded.state and not isJob then error(decoded.error, 0) end
    return decoded
end

return Client
