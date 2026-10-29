// The website's live clocks. Same calendar arithmetic as the app: years, months and days are counted
// across real month lengths, so exactly one year reads "1 year", not "365 days".
//
// <form data-clock-form> with a datetime-local input fills its [data-clock-out] readout every second.
// Any element with data-since="ISO date" shows the time since that date, ticking.
(function () {
  function diff(start, now) {
    var years = now.getFullYear() - start.getFullYear();
    var months = now.getMonth() - start.getMonth();
    var days = now.getDate() - start.getDate();
    var secs = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) -
               (start.getHours() * 3600 + start.getMinutes() * 60 + start.getSeconds());
    if (secs < 0) { secs += 86400; days -= 1; }
    if (days < 0) { days += new Date(now.getFullYear(), now.getMonth(), 0).getDate(); months -= 1; }
    if (months < 0) { months += 12; years -= 1; }
    return { years: years, months: months, days: days, hours: Math.floor(secs / 3600), minutes: Math.floor(secs / 60) % 60, seconds: secs % 60 };
  }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function format(start, now) {
    if (now - start < 1000) return "Just now";
    var d = diff(start, now), parts = [];
    if (d.years) parts.push(plural(d.years, "year"));
    if (d.months) parts.push(plural(d.months, "month"));
    if (d.days || parts.length) parts.push(plural(d.days, "day"));
    return (parts.length ? parts.join(", ") + ", " : "") + pad(d.hours) + ":" + pad(d.minutes) + ":" + pad(d.seconds);
  }
  function totalDays(start, now) { return Math.floor((now - start) / 86400000); }

  var forms = document.querySelectorAll("[data-clock-form]");
  forms.forEach(function (form) {
    var input = form.querySelector("input"), out = form.querySelector("[data-clock-out]"), sub = form.querySelector("[data-clock-sub]");
    form.hidden = false;
    var start = null;
    function read() {
      var value = input.value ? new Date(input.value) : null;
      start = value && !isNaN(value) && value <= new Date() ? value : null;
      tick();
    }
    function tick() {
      if (!start) { out.textContent = "Pick a date"; if (sub) sub.textContent = "When did it start? Be honest."; return; }
      var now = new Date();
      out.textContent = format(start, now);
      if (sub) { var n = totalDays(start, now); sub.textContent = n === 0 ? "Fresh. Still tender." : "That is " + n.toLocaleString("en") + " " + (n === 1 ? "day" : "days") + ". The clock is still running."; }
    }
    input.addEventListener("input", read);
    form.addEventListener("submit", function (e) { e.preventDefault(); read(); });
    read();
    setInterval(tick, 1000);
  });

  document.querySelectorAll("[data-since]").forEach(function (el) {
    var start = new Date(el.getAttribute("data-since"));
    function tick() { el.textContent = format(start, new Date()); }
    tick();
    setInterval(tick, 1000);
  });
})();
