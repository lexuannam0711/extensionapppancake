const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

async function main() {
  console.log('=== Lay Access Token Admin Supabase ===\n');
  const supabaseUrl = (await question('Supabase URL: ')).trim().replace(/\/$/, '');
  const anonKey = (await question('Supabase Anon Key: ')).trim();
  const email = (await question('Email Admin: ')).trim();
  const password = (await question('Password: ')).trim();
  rl.close();

  if (!supabaseUrl || !anonKey || !email || !password) {
    console.error('Loi: Vui long dien day du 4 thong tin.');
    process.exit(1);
  }

  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();
    if (!res.ok) {
      console.error('\nThat bai:', data.error_description || data.msg || data.error || JSON.stringify(data));
      if (data.msg === 'Email not confirmed' || data.error_description === 'Email not confirmed') {
        console.log('\n-> Huong dan: Vao Supabase > Authentication > Users > chon menu 3 cham ... > Confirm user.');
      }
      process.exit(1);
    }

    console.log('\n========================================');
    console.log('Access token:');
    console.log(data.access_token);
    console.log('========================================\n');
  } catch (err) {
    console.error('Loi:', err.message);
  }
}

main();
