with open('static/js/map.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

for idx, line in enumerate(lines):
    if 'renderRedZones(' in line:
        print(f"renderRedZones at line {idx+1}")
        for j in range(idx, min(idx+60, len(lines))):
            print(f"{j+1}: {lines[j]}", end="")
        break
