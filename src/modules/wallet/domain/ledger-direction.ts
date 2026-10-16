export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export const oppositeDirection = (d: LedgerDirection): LedgerDirection =>
  d === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
