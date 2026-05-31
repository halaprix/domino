const { createPublicClient, http, multicall3Abi, MULTICALL3_ADDRESS } = require('viem');

const client = createPublicClient({ transport: http('https://eth.llamarpc.com'), cacheTime: 0 });
console.log('readContract:', typeof client.readContract);
console.log('request:', typeof client.request);

(async () => {
  try {
    const result = await client.readContract({
      address: MULTICALL3_ADDRESS,
      abi: multicall3Abi,
      functionName: 'aggregate3',
      args: [[[{ target: '0x0000000000000000000000000000000000000001', allowFailure: true, callData: '0x'}]]]
    });
    console.log('aggregate3 result type:', typeof result, Array.isArray(result));
  } catch(e) {
    console.log('error:', e.message.slice(0,200));
  }
})();