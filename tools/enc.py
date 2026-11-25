"""TP-LINK 'hex_md5' 密码编码（实为固定密钥异或，并非 MD5）。用法: python enc.py <password>"""
import sys

ALPHA = ("yLwVl0zKqws7LgKPRQ84Mdt708T1qQ3Ha7xv3H7NyU84p21BriUWBU43odz3iP4rBL3cD02KZciXTysVXiV8ngg6vL48rPJyAUw0HurW20"
         "xqxv9aYb4M9wK1Ae0wlro510qXeU07kV57fQMc8L6aLgMLwygtc0F10a0Dg70TOoouyFhdysuRMO51yY5ZlOZZLEal1h0t9YQW0Ko7oBwmCAHoic4HYbUyVeU3sfQ1xtXcPcf1aT303wAQhv66qzW")
KEY1 = "RDpbLfCPsJZ7fiv"


def security_encode(pwd: str, key1: str = KEY1, alpha: str = ALPHA) -> str:
    out = []
    for i in range(max(len(pwd), len(key1))):
        a = b = 187
        if i >= len(pwd):
            b = ord(key1[i])
        elif i >= len(key1):
            a = ord(pwd[i])
        else:
            a, b = ord(pwd[i]), ord(key1[i])
        out.append(alpha[(a ^ b) % len(alpha)])
    return "".join(out)


if __name__ == "__main__":
    print(security_encode(sys.argv[1]))
