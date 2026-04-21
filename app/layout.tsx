import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ROAS Heatmap Dashboard',
  description: 'Interactive ROAS heatmap with dynamic filters for campaign traffic.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
