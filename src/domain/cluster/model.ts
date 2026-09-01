import {Schema} from 'effect';

export class ClusterInfo extends Schema.Class<ClusterInfo>(
  'learn-tarantool/domain/cluster/ClusterInfo',
)({
  bucket_count: Schema.Number,
  replicasets: Schema.Record(Schema.String, Schema.Unknown),
}) {}
export const ClusterInfoSchema = ClusterInfo;
