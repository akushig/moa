import { describe, it, expect } from 'vitest';
import { parseStockCsv } from '../lib/parsers/stock-csv';

describe('parseStockCsv', () => {
  it('범용 CSV — 매수/매도 파싱', () => {
    const csv = `일자,종목코드,종목명,구분,수량,단가,수수료,세금
2024-03-15,005930,삼성전자,매수,10,72000,1500,0
2024-04-20,005930,삼성전자,매도,5,78000,1500,975`;
    const r = parseStockCsv(csv);
    expect(r.transactions).toHaveLength(2);
    expect(r.errors).toHaveLength(0);
    expect(r.transactions[0].side).toBe('buy');
    expect(r.transactions[0].assetSymbol).toBe('KOSPI:005930');
    expect(r.transactions[0].qty.toNumber()).toBe(10);
    expect(r.transactions[1].side).toBe('sell');
    expect(r.transactions[1].fee.toNumber()).toBe(1500 + 975);
  });

  it('KOSDAQ 시장 구분', () => {
    const csv = `일자,종목코드,종목명,구분,수량,단가,시장
2024-05-01,035720,카카오,매수,20,45000,KOSDAQ`;
    const r = parseStockCsv(csv);
    expect(r.transactions[0].assetSymbol).toBe('KOSDAQ:035720');
  });

  it('빈 CSV → 에러', () => {
    const r = parseStockCsv('');
    expect(r.transactions).toHaveLength(0);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('필수 컬럼 누락 → 에러', () => {
    const csv = `이름,값\n삼성,100`;
    const r = parseStockCsv(csv);
    expect(r.transactions).toHaveLength(0);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('배당/이체 행은 skip (매수/매도만)', () => {
    const csv = `일자,종목코드,종목명,구분,수량,단가
2024-01-10,005930,삼성전자,배당,0,0
2024-01-15,005930,삼성전자,매수,5,70000`;
    const r = parseStockCsv(csv);
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0].side).toBe('buy');
  });

  it('콤마 포함 금액 + BOM 처리', () => {
    const csv = `\uFEFF일자,종목코드,종목명,구분,수량,단가,수수료
2024-06-01,005930,삼성전자,매수,100,"72,000","1,500"`;
    const r = parseStockCsv(csv);
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0].price.toNumber()).toBe(72000);
    expect(r.transactions[0].fee.toNumber()).toBe(1500);
  });
});
