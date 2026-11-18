const MESSY_EXPENSES_CSV = `Txn Dt,Vendor / Payee,Cat,Amt ($),Curr,Pay Status,Notes
11/04/26,  AWS cloud services ,Infrastructure,"$1,240.00",USD,paid,Monthly hosting
2026.11.05,figma inc.,Software,USD 45.00,usd,PAID,Design seats
Nov 6 2026,Slack Technologies,Software,"€89,50",EUR,Settled,Team workspace
06-11-2026,Slack Technologies,Software,"€89,50",EUR,Settled,Duplicate export entry
2026-11-08,Stripe Processing Fee,Banking,(18.40),USD,Paid,Refund adjustment
11/09/26,DELTA AIR LINES,Travel,$412.8,USD,pending,Client site visit
2026/11/10,wework coworking,Office,#DIV/0!,USD,unpaid,Broken split formula
Nov 11th 2026,Adobe Creative Cloud,Software,$59.99 ,USD,Paid,
12.11.2026,Upwork Escrow,Contractors,"2,150.00 USD",USD,settled,Frontend sprint
2026-11-14,  Blue Bottle Coffee,Meals,$18.75,USD,paid,Client meeting`;

const MESSY_CLIENT_ROSTER_CSV = `Cli_Nm,Contact Person,Ph #,E-mail,Mrr ($),Renwl Dt,Acct_Stat
acme logistics llc,Sarah Jenkins,(415) 555-0192,sjenkins@acmelogistics.com,"$2,400.00",12/01/26,active
Northstar Dental,Dr. Marcus Chen,415.555.0148,mchen@northstardental.io,USD 1850,2026.12.15,ACTIVE
brightleaf media,Elena Rostova,+1 212 555 0174,,$950.00,Dec 20 2026,Pending
Harbor Freight Co,David Kim,312-555-0133,dkim@harborco.com,#REF!,01/05/2027,At Risk
Summit Architecture,Priya Patel,1 (646) 555-0189,priya@summitarch.com,"1,500.00",2027-01-10,Active
velox robotics,Tomás Silva,555-019,tsilva@velox.ai,"$3,200",15-01-2027,active
Cedar & Pine Goods,Hannah Abbott,206 555 0111,hannah@cedarpine.co,$780.50,Jan 22 2027,Active`;

function buildOversizedLedgerCsv(rowCount: number): string {
  const lines = ['Date,Merchant,Category,Amount,Status'];
  const vendors = ['AWS', 'Figma', 'Linear', 'Notion', 'Vercel', 'Stripe', 'HubSpot'];
  for (let i = 1; i <= rowCount; i++) {
    const day = String(((i - 1) % 28) + 1).padStart(2, '0');
    const vendor = vendors[i % vendors.length];
    const amt = `$${(25 + i * 7.35).toFixed(2)}`;
    lines.push(`11/${day}/26,${vendor},Operations,${amt},${i % 5 === 0 ? 'pending' : 'paid'}`);
  }
  return lines.join('\n');
}

export function createSampleCsvFile(sampleKey: 'expenses' | 'roster' | 'oversized'): File {
  if (sampleKey === 'expenses') {
    return new File([MESSY_EXPENSES_CSV], 'q4_freelance_expenses_raw.csv', {
      type: 'text/csv',
    });
  }
  if (sampleKey === 'roster') {
    return new File([MESSY_CLIENT_ROSTER_CSV], 'client_roster_dirty.csv', {
      type: 'text/csv',
    });
  }
  return new File([buildOversizedLedgerCsv(65)], 'oversized_ledger_65rows.csv', {
    type: 'text/csv',
  });
}

export async function createSampleReceiptImageFile(): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 840;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable.');
  }

  // Crisp paper receipt background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 2;
  ctx.strokeRect(24, 24, canvas.width - 48, canvas.height - 48);

  ctx.fillStyle = '#0F172A';
  ctx.font = 'bold 28px monospace';
  ctx.fillText('METRO OFFICE SUPPLY CO.', 56, 86);

  ctx.fillStyle = '#475569';
  ctx.font = '18px monospace';
  ctx.fillText('742 Market St, San Francisco, CA 94103', 56, 120);
  ctx.fillText('Tel: (415) 555-0164', 56, 148);
  ctx.fillText('Receipt #: INV-2026-8841', 56, 186);
  ctx.fillText('Date: Nov 09, 2026  14:32', 56, 214);

  ctx.strokeStyle = '#94A3B8';
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(56, 244);
  ctx.lineTo(584, 244);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#0F172A';
  ctx.font = 'bold 18px monospace';
  ctx.fillText('QTY   DESCRIPTION                    AMOUNT', 56, 282);

  const items = [
    ['2', 'Ergonomic Desk Lamp LED', '$128.00'],
    ['1', 'USB-C Thunderbolt Dock', 'USD 189.50'],
    ['4', 'Archival Ledger Paper (Ream)', '$54.00'],
    ['1', 'Shipping & Handling', '$14.50'],
  ];

  ctx.font = '18px monospace';
  let y = 328;
  for (const [qty, desc, amt] of items) {
    ctx.fillStyle = '#1E293B';
    ctx.fillText(qty.padEnd(6) + desc.padEnd(31) + amt, 56, y);
    y += 42;
  }

  ctx.strokeStyle = '#94A3B8';
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(56, 520);
  ctx.lineTo(584, 520);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#334155';
  ctx.font = '19px monospace';
  ctx.fillText('Subtotal:                         $386.00', 56, 564);
  ctx.fillText('CA Sales Tax (8.625%):             $33.29', 56, 598);

  ctx.fillStyle = '#0F172A';
  ctx.font = 'bold 24px monospace';
  ctx.fillText('TOTAL PAID (VISA *4242):          $419.29', 56, 654);

  ctx.fillStyle = '#64748B';
  ctx.font = '16px monospace';
  ctx.fillText('Thank you for your business.', 56, 720);
  ctx.fillText('Keep for tax & expense reconciliation.', 56, 748);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Failed to render receipt PNG'))), 'image/png');
  });

  return new File([blob], 'metro_office_receipt_nov2026.png', { type: 'image/png' });
}
