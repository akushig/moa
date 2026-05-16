// 한국 증권사 거래내역 CSV 파서.
// 지원 형식: 키움 (HTS), 삼성 (POP), 미래에셋 (mStock), 통합 (범용 fallback).
//
// 공통 출력: StockTransaction[] — Transaction 테이블에 insert 가능한 형태.

import { Decimal } from '@/lib/decimal';

export type StockTransaction = {
  timestamp: Date;
  assetSymbol: string; // "KOSPI:005930" or "KOSDAQ:035720"
  name: string; // 종목명 (display 용)
  side: 'buy' | 'sell';
  qty: Decimal;
  price: Decimal; // 주당 가격 (KRW)
  fee: Decimal; // 수수료 + 세금
  currency: 'KRW';
};

// CSV text → rows (handle BOM, CRLF, quoted fields)
function csvToRows(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = clean.split('\n').filter((l) => l.trim() !== '');
  return lines.map((line) => {
    const fields: string[] = [];
    let current = '';
    let inQuote = false;
    for (const ch of line) {
      if (inQuote) {
        if (ch === '"') inQuote = false;
        else current += ch;
      } else {
        if (ch === '"') inQuote = true;
        else if (ch === ',') {
          fields.push(current.trim());
          current = '';
        } else current += ch;
      }
    }
    fields.push(current.trim());
    return fields;
  });
}

// 숫자 파싱 (콤마 제거)
function num(s: string): number {
  return Number(s.replace(/,/g, '').replace(/원/g, '').trim()) || 0;
}

// 날짜 파싱: "2024-01-15", "2024.01.15", "20240115", "2024/01/15"
function parseDate(s: string): Date | null {
  const clean = s.replace(/[./]/g, '-').trim();
  // YYYYMMDD
  if (/^\d{8}$/.test(clean)) {
    const iso = `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`;
    const d = new Date(`${iso}T09:00:00+09:00`);
    return isNaN(d.getTime()) ? null : d;
  }
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    const d = new Date(`${clean}T09:00:00+09:00`);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// 종목코드 → "KOSPI:005930" or "KOSDAQ:035720" 형태.
// 시장 구분이 없으면 KOSPI 로 가정 (대부분).
function symbolFromCode(code: string, market?: string): string {
  const c = code.replace(/[^0-9A-Za-z]/g, '').padStart(6, '0');
  const m = market?.toUpperCase().includes('KOSDAQ') ? 'KOSDAQ' : 'KOSPI';
  return `${m}:${c}`;
}

// 매수/매도 판정
function parseSide(s: string): 'buy' | 'sell' | null {
  const t = s.trim();
  if (/매수|buy|입고|보통매수|시장가매수/i.test(t)) return 'buy';
  if (/매도|sell|출고|보통매도|시장가매도/i.test(t)) return 'sell';
  return null;
}

// 헤더 컬럼 매칭 — 유연하게 partial match
function findCol(headers: string[], ...patterns: string[]): number {
  for (const pat of patterns) {
    const idx = headers.findIndex((h) => h.includes(pat));
    if (idx >= 0) return idx;
  }
  return -1;
}

export type ParseResult = {
  transactions: StockTransaction[];
  errors: string[];
  format: string;
};

export function parseStockCsv(text: string): ParseResult {
  const rows = csvToRows(text);
  if (rows.length < 2) return { transactions: [], errors: ['빈 CSV 또는 헤더만 있음'], format: 'unknown' };

  const headers = rows[0].map((h) => h.toLowerCase().replace(/\s/g, ''));
  const dataRows = rows.slice(1);

  // 컬럼 탐색
  const iDate = findCol(headers, '일자', '거래일', '날짜', 'date', '체결일');
  const iCode = findCol(headers, '종목코드', '코드', 'code', '종목번호');
  const iName = findCol(headers, '종목명', '종목', 'name', '상품명');
  const iSide = findCol(headers, '구분', '매매구분', '거래구분', '매도매수', 'type', 'side', '거래유형');
  const iQty = findCol(headers, '수량', '체결수량', 'qty', 'quantity', '거래수량');
  const iPrice = findCol(headers, '단가', '체결단가', '가격', 'price', '체결가', '매매단가');
  const iFee = findCol(headers, '수수료', '제비용', 'fee', 'commission');
  const iTax = findCol(headers, '세금', '거래세', 'tax', '제세금');
  const iMarket = findCol(headers, '시장', 'market', '거래소');

  if (iDate < 0 || (iCode < 0 && iName < 0) || iSide < 0 || iQty < 0) {
    return {
      transactions: [],
      errors: [`필수 컬럼 미발견. 헤더: ${rows[0].join(', ')}. 필요: 일자, 종목코드/종목명, 구분, 수량`],
      format: 'unknown',
    };
  }

  // 포맷 추정
  const h0 = rows[0].join(' ');
  const format = h0.includes('키움') || h0.includes('영웅문')
    ? '키움'
    : h0.includes('삼성') || h0.includes('POP')
      ? '삼성'
      : h0.includes('미래에셋') || h0.includes('mStock')
        ? '미래에셋'
        : '범용';

  const transactions: StockTransaction[] = [];
  const errors: string[] = [];

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i];
    const lineNum = i + 2;

    const date = parseDate(r[iDate] ?? '');
    if (!date) {
      errors.push(`${lineNum}행: 날짜 파싱 실패 "${r[iDate]}"`);
      continue;
    }

    const side = parseSide(r[iSide] ?? '');
    if (!side) {
      // 배당, 이체 등 매수/매도 아닌 행은 skip (에러 아님)
      continue;
    }

    const qty = num(r[iQty] ?? '0');
    if (qty <= 0) continue;

    const price = num(r[iPrice] ?? '0');
    const fee = num(r[iFee] ?? '0') + (iTax >= 0 ? num(r[iTax] ?? '0') : 0);

    const code = iCode >= 0 ? r[iCode] ?? '' : '';
    const name = iName >= 0 ? r[iName] ?? '' : code;
    const market = iMarket >= 0 ? r[iMarket] ?? '' : '';

    const assetSymbol = code ? symbolFromCode(code, market) : `STOCK:${name}`;

    transactions.push({
      timestamp: date,
      assetSymbol,
      name,
      side,
      qty: new Decimal(qty),
      price: new Decimal(price),
      fee: new Decimal(fee),
      currency: 'KRW',
    });
  }

  return { transactions, errors, format };
}
