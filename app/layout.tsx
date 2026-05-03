import './globals.css';

export const metadata = {
  title: 'moa',
  description: '한국형 통합 자산 트래커',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
