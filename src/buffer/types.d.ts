import { IBufferFacade } from "./BufferFacade.ts";

export type IReadBlockFixed<Value> = {
  readonly size: number;
  readonly read: (buffer: IBufferFacade, offset: number) => Value;
};

export type IReadBlockVariable<Value> = {
  readonly size: (buffer: IBufferFacade, offset: number) => number;
  readonly read: (buffer: IBufferFacade, offset: number) => Value;
};

export type IWriteBlockVariable<Value> = {
  readonly size: (value: Value) => number;
  readonly write: (buffer: IBufferFacade, offset: number, value: Value) => void;
};

export type IWriteBlockFixed<Value> = {
  readonly size: number;
  readonly write: (buffer: IBufferFacade, offset: number, value: Value) => void;
};

export type IReadBlock<Value> =
  | IReadBlockFixed<Value>
  | IReadBlockVariable<Value>;

export type IWriteBlock<Value> =
  | IWriteBlockFixed<Value>
  | IWriteBlockVariable<Value>;

export type IBlockFixed<RValue, WValue = RValue> = {
  read: IReadBlockFixed<RValue>;
  write: IWriteBlockFixed<WValue>;
};

export type IBlock<RValue, WValue = RValue> = {
  read: IReadBlock<RValue>;
  write: IWriteBlock<WValue>;
};
