local M = {}

M.bucket_count = 3000
M.sharding = {
    ['aaaaaaaa-0000-4000-b000-000000000000'] = {
        replicas = {
            ['aaaaaaaa-aaaa-4000-b000-000000000001'] = {
                uri = 'storage:storage-secret@storage-1:3301',
                name = 'storage-1',
                master = true,
            },
        },
    },
    ['bbbbbbbb-0000-4000-b000-000000000000'] = {
        replicas = {
            ['bbbbbbbb-bbbb-4000-b000-000000000001'] = {
                uri = 'storage:storage-secret@storage-2:3301',
                name = 'storage-2',
                master = true,
            },
        },
    },
}

return M

