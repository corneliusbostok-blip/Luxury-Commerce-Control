(function (global) {
  var KEY = "velden_cart_v1";

  function parse() {
    try {
      var raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function save(lines) {
    localStorage.setItem(KEY, JSON.stringify(lines));
    global.dispatchEvent(new CustomEvent("velden-cart"));
  }

  function lineKey(line) {
    return line.productId + "|" + (line.size || "") + "|" + (line.color || "");
  }

  function getCart() {
    return parse();
  }

  function countItems() {
    return getCart().reduce(function (n, l) {
      return n + (l.quantity || 1);
    }, 0);
  }

  function addToCart(item) {
    var lines = parse();
    var q = Math.min(10, Math.max(1, parseInt(item.quantity, 10) || 1));
    var line = {
      productId: item.productId,
      name: item.name,
      image: item.image || "",
      price: Number(item.price),
      size: item.size || "",
      color: item.color || "",
      categoryLabel: item.categoryLabel || "",
      quantity: q,
    };
    var k = lineKey(line);
    var found = false;
    for (var i = 0; i < lines.length; i++) {
      if (lineKey(lines[i]) === k) {
        lines[i].quantity = Math.min(10, (lines[i].quantity || 1) + q);
        found = true;
        break;
      }
    }
    if (!found) lines.push(line);
    save(lines);
  }

  function setQty(index, quantity) {
    var lines = parse();
    var q = Math.min(10, Math.max(1, parseInt(quantity, 10) || 1));
    if (lines[index]) {
      lines[index].quantity = q;
      save(lines);
    }
  }

  function removeLine(index) {
    var lines = parse();
    lines.splice(index, 1);
    save(lines);
  }

  function clearCart() {
    save([]);
  }

  global.VeldenCart = {
    getCart: getCart,
    countItems: countItems,
    addToCart: addToCart,
    setQty: setQty,
    removeLine: removeLine,
    clearCart: clearCart,
  };
})(typeof window !== "undefined" ? window : globalThis);
