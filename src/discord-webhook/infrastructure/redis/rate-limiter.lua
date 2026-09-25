local key = KEYS[1]
local interval_ms = tonumber(ARGV[1])
local now_ms = tonumber(ARGV[2])
local ttl_ms = tonumber(ARGV[3])
local next_allowed_at = tonumber(redis.call('GET', key) or '0')
local reservation_at = math.max(now_ms, next_allowed_at)
local delay_ms = reservation_at - now_ms

redis.call('SET', key, reservation_at + interval_ms, 'PX', ttl_ms)
return { delay_ms, reservation_at }
