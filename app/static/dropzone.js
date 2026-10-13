document.querySelectorAll('[data-dropzone]').forEach((zone) => {
  const input = zone.querySelector('input[type=file]');
  const label = zone.querySelector('.fname');
  const show = () => { label.textContent = input.files.length ? input.files[0].name : ''; };
  input.addEventListener('change', show);
  ['dragenter', 'dragover'].forEach((e) => zone.addEventListener(e, (ev) => { ev.preventDefault(); zone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((e) => zone.addEventListener(e, () => zone.classList.remove('drag')));
  zone.addEventListener('drop', (ev) => {
    ev.preventDefault();
    if (ev.dataTransfer.files.length) { input.files = ev.dataTransfer.files; show(); }
  });
});
