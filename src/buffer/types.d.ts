export type IReadBlockFixed<Value> = {
  readonly size: number;
  readonly read: (buffer: Uint8Array, offset: number) => Value;
};

export type IReadBlockVariable<Value> = {
  readonly size: (buffer: Uint8Array, offset: number) => number;
  readonly read: (buffer: Uint8Array, offset: number) => Value;
};

export type IWriteBlockVariable<Value> = {
  readonly size: (value: Value) => number;
  readonly write: (buffer: Uint8Array, offset: number, value: Value) => void;
};

export type IWriteBlockFixed<Value> = {
  readonly size: number;
  readonly write: (buffer: Uint8Array, offset: number, value: Value) => void;
};

export type IReadBlock<Value> =
  | IReadBlockFixed<Value>
  | IReadBlockVariable<Value>;

export type IWriteBlock<Value> =
  | IWriteBlockFixed<Value>
  | IWriteBlockVariable<Value>;

export type IBlockFixed<Value> = {
  read: IReadBlockFixed<Value>;
  write: IWriteBlockFixed<Value>;
};

export type IBlock<Value> = {
  read: IReadBlock<Value>;
  write: IWriteBlock<Value>;
};
