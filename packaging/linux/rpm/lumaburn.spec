Name:           lumaburn
Version:        0.2.1
Release:        1%{?dist}
Summary:        Professional Cross-Platform Laser Cutting Software
License:        Proprietary
URL:            https://lumaburn.app
Source0:        %{name}-%{version}.tar.gz

BuildArch:      x86_64
Requires:       nodejs >= 16.0.0

%description
LumaBurn provides a high-performance, reactive interface for 
OMTech, Longer Ray 5, and other GRBL-based laser cutters.

%prep
%autosetup

%install
rm -rf $RPM_BUILD_ROOT
mkdir -p %{buildroot}/usr/lib/udev/rules.d/
cp packaging/linux/99-lumaburn.rules %{buildroot}/usr/lib/udev/rules.d/99-lumaburn.rules

%post
udevadm control --reload-rules
udevadm trigger

%files
/usr/lib/udev/rules.d/99-lumaburn.rules

%changelog
* Thu Apr 16 2026 support@lumaburn.app - 0.2.1-1
- Initial hardware permission setup for CH340 and CH341 lasers.
