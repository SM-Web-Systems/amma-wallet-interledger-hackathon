#!/bin/sh
# TEST-ONLY: create a throwaway CA and one certificate for the four *.amma.test
# names used by compose.local-tls.yml. Output goes to the git-ignored secrets/tls/.
set -eu
cd "$(dirname "$0")"
mkdir -p secrets/tls && cd secrets/tls
[ -f ca.pem ] && { echo "secrets/tls already exists; delete it to regenerate"; exit 0; }
umask 077
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=Amma local test CA" \
  -keyout ca.key -out ca.pem 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=amma.test" -keyout server.key -out server.csr 2>/dev/null
printf 'subjectAltName=DNS:pay-a.amma.test,DNS:auth-a.amma.test,DNS:pay-b.amma.test,DNS:auth-b.amma.test\nextendedKeyUsage=serverAuth\n' > ext.cnf
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 30 -extfile ext.cnf -out server.pem 2>/dev/null
rm -f server.csr ext.cnf ca.srl ca.key
chmod 644 ca.pem server.pem server.key
echo "Created secrets/tls (CA key discarded). Map the four *.amma.test names to 127.0.0.1 in your hosts file."
