CBTVEN v4.3.26 — Uji kompatibilitas SQLite untuk CloudLinux/cPanel

PERUBAHAN:
- better-sqlite3 dipatok ke 9.6.0 untuk menguji kompatibilitas yang lebih baik dengan lingkungan hosting. Ini bukan jaminan; keberhasilan tetap harus diverifikasi di server.
- package-lock.json dan node_modules tidak disertakan agar cPanel/CloudLinux membuat dependensi dan symlink node_modules sendiri.
- Folder data dan database sengaja TIDAK disertakan agar database di hosting tidak tertimpa.

CARA PEMAKAIAN AMAN:
1. Pastikan backup database hosting sudah tersedia.
2. Upload ZIP ini ke folder aplikasi hosting yang benar, lalu ekstrak di folder aplikasi tersebut. ZIP ini tidak berisi folder data atau node_modules, sehingga keduanya tidak ditimpa. File server.js, package.json, public, dan vendor akan diperbarui.
3. Pastikan Application root di cPanel tetap sesuai dengan direktori aplikasi yang sudah terdaftar. Jangan ubah root melalui tombol Save jika itu memicu relokasi folder.
4. Pada Node.js Selector, gunakan Node.js 20 dan file startup server.js.
5. Jalankan Run NPM Install satu kali dan tunggu selesai.
6. Jika masih gagal pada better-sqlite3, jangan menghapus data atau mengulang instalasi terus-menerus; simpan log error untuk langkah berikutnya.
7. Setelah dependensi berhasil, restart aplikasi dan uji login serta Bank Soal/Jadwal.

CATATAN:
Versi 9.6.0 dipilih sebagai percobaan kompatibilitas, bukan jaminan bahwa server mendukung binary/build. Error GLIBC atau kegagalan kompilasi lanjutan mungkin memerlukan bantuan provider atau strategi database berbeda.
