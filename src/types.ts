export interface NewUser {
  id: number;
  email: string;
  name: string;
  age: number;
  created_at?: number;
}

export interface User extends Required<NewUser> {
  bucket_id: number;
}

export interface UserChanges {
  email?: string;
  name?: string;
  age?: number;
}

export interface ClusterInfo {
  bucket_count: number;
  replicasets: Record<string, unknown>;
}

export interface CursorPage<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}
