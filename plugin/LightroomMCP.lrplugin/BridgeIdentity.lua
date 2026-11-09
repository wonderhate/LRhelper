local version = require('Info').VERSION
local Identity = {}

function Identity.describe()
    return {
        pong = true,
        product = "wonderhate/LRhelper",
        plugin_version = string.format("%d.%d.%d", version.major, version.minor, version.revision),
        protocol = 1,
        capability_hash = "1032980ce42e443aacbbcfc5ba9dbb86f215789b21bc201cb54074365241e96d",
    }
end

return Identity
