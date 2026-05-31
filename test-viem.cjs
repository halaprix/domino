const { createPublicClient, http } = require('viem');

const client = createPublicClient({ transport: http('https://eth.llamarpc.com'), cacheTime: 0 });

// Test readContract works for our use case: symbol() on USDC
(async () => {
  try {
    const result = await client.readContract({
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      abi: [{"type":"function","name":"symbol","inputs":[],"outputs":[{"name":"","type":"string"}],"stateMutability":"view"}],
      functionName: 'symbol',
    });
    console.log('USDC symbol:', result);
  } catch(e) {
    console.log('error:', e.message.slice(0,200));
  }
})();